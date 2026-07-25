'use strict';
/**
 * E2E webServer entrypoint — provision the isolated clone, THEN boot the server.
 *
 * ─── Root cause this fixes (the whole-suite `warehouses` 422) ────────────────
 * Playwright starts the `webServer` BEFORE it runs `globalSetup`. This is not a
 * quirk of our config — it is the runner's order: createGlobalSetupTasks() lists
 * `createPluginSetupTasks(...)` (the WebServerPlugin) ahead of `globalSetups`, so
 * the server process is up before any globalSetup hook fires.
 *
 * Provisioning used to live in globalSetup (e2e/erp-global-setup.ts and the POS
 * config both ran scripts/e2e/provision-e2e-db.js there). So the real sequence
 * was:
 *
 *   1. webServer: `node server.js` boots → autoInitDB() runs the boot migrations
 *      against whatever `_e2e` currently is (adds warehouses.name_en, creates the
 *      *_queue tables, …);
 *   2. globalSetup: provision-e2e-db.js DROPs `_e2e` and re-clones it from the
 *      base schema (which has NO name_en, NO migration-only tables), wiping every
 *      boot-migration change out from under the already-running server;
 *   3. tests run. The server keeps answering (its pool resolves table names
 *      against the recreated catalog), but any query that reads a migration-only
 *      column now fails: GET /api/inventory/v2/warehouses SELECTs `w.name_en` and
 *      returned 422 "Unknown column 'w.name_en'" for the entire suite.
 *
 * The fix is ordering, not the route: clone FIRST, then let server.js's own boot
 * migrations run against the FINAL clone — exactly how production works (an
 * existing database, then `node server.js` migrates it on boot). Because the
 * clone has to exist before the server process starts, and globalSetup cannot
 * guarantee that, provisioning moves out of globalSetup and into the webServer
 * command — this wrapper.
 *
 * Honors E2E_SKIP_DB_PROVISION=1 (reuse the existing clone while iterating on a
 * single spec — never in a gate run), matching the old globalSetup contract.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

if (process.env.E2E_SKIP_DB_PROVISION === '1') {
  console.log('[e2e-db] provisioning SKIPPED (E2E_SKIP_DB_PROVISION=1) — reusing the existing clone');
} else {
  // ── Clone SOURCE/TARGET must be derived, NOT inherited ──────────────────────
  // provision-e2e-db.js computes SOURCE_DB from DB_NAME and TARGET_DB from
  // E2E_DB_NAME (TARGET defaults to `${SOURCE}_e2e`). When provisioning lived in
  // Playwright's globalSetup it ran in the runner process, whose DB_NAME was the
  // DEV name from .env — so it correctly cloned dev -> dev_e2e. Here it runs
  // inside the webServer command, whose env deliberately sets
  // DB_NAME=MYSQL_DATABASE=<the _e2e clone> so the SERVER points at the clone. If
  // we let provision-e2e-db.js inherit that unchanged it would clone
  // <clone> -> <clone>_e2e and NEVER refresh the DB the server actually uses —
  // silently serving stale, write-accumulating data (a clean machine would fail
  // outright on the missing source). So derive the pair explicitly: the server's
  // DB is a throwaway `<dev>_e2e`, so SOURCE = that name minus its _e2e suffix,
  // TARGET = the server's DB itself. Passed down via the child env; our OWN
  // process env is untouched, so the server (required below) still connects to
  // the clone.
  const SERVER_DB = process.env.MYSQL_DATABASE || process.env.DB_NAME || '';
  if (!/_e2e$/.test(SERVER_DB)) {
    console.error(`[e2e-db] REFUSING: server DB "${SERVER_DB}" is not an _e2e clone name — refusing to guess a provisioning source/target.`);
    process.exit(2);
  }
  const SOURCE_DB = SERVER_DB.replace(/_e2e$/, '');
  // Synchronous + fail-closed: if the clone can't be built, execFileSync throws,
  // this process exits non-zero, and Playwright reports the webServer as failed
  // instead of running the suite against a stale or missing database. The timeout
  // is kept BELOW the configs' webServer.timeout (300s) so a slow clone fails as a
  // clear clone error rather than an opaque "port never opened" from Playwright.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'e2e', 'provision-e2e-db.js')], {
    stdio: 'inherit',
    timeout: 240_000,
    env: { ...process.env, DB_NAME: SOURCE_DB, E2E_DB_NAME: SERVER_DB },
  });
}

// E2E determinism: the name_en backfill worker keeps MUTATING menu rows for
// minutes after boot (batch of 20 per 60s poll — ~8 min for the 2,000-row dev
// clone), so any screen that renders item names or missing-name counts
// depends on how long the server has been up: visual baselines and count
// assertions pass in an isolated spec run yet fail mid-gate (bit us on BOTH
// menu-list--en and pos-main-en). The worker ships its own test off-switch —
// use it, so the E2E database stays frozen at clone state for the whole
// suite. The worker's own behavior is covered by its unit/integration tests,
// not by these UI suites.
process.env.NAME_EN_BACKFILL_DISABLE_WORKER = '1';

// server.js has no `require.main === module` guard: requiring it runs the boot
// IIFE (autoInitDB → runMigrations → app.listen) in THIS process. That is
// deliberate — Playwright's port-wait and teardown then target the real server
// process directly, with no intermediate child to signal-forward to.
require(path.join(ROOT, 'server.js'));
