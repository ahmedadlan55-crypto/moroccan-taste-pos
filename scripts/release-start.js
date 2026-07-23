#!/usr/bin/env node
'use strict';
/* ─── Production release chain — the REAL run command ────────────────────────
 *
 * This is what the Dockerfile's CMD invokes, and it is the single definition
 * of the release contract. It exists as a Node script rather than an inline
 * `sh -c` string for one concrete reason: it has to be RUNNABLE and PROVABLE
 * on a developer machine (Windows included) against a genuinely empty
 * database. A contract that can only be exercised inside a container is a
 * contract nobody verifies.
 *
 * WHAT IT GUARANTEES
 *   Every migration is applied, in order, BEFORE the HTTP port is bound, and
 *   any failure stops the chain — the server can never start on an incomplete
 *   schema. Each step is a separate child process whose exit code is checked
 *   explicitly; nothing is piped, nothing is `||`-ed, no `npm run` wrapper
 *   sits between a failure and this process's own exit code.
 *
 * WHY THE ORDER IS WHAT IT IS (and not `db:init -> db:migrate -> start`)
 *   `db/migrate.js` cannot run straight after a bare `db/schema.sql`
 *   baseline. The numbered migrations were authored against the schema as
 *   server.js's legacy runMigrations() had already evolved it:
 *   0005_user_employee_link.sql ALTERs `hr_employees` and
 *   0014_brand_branch_scope.sql ALTERs `pos_orders` — tables that exist in
 *   NEITHER schema.sql NOR any numbered migration. Only server.js creates
 *   them. Their INFORMATION_SCHEMA guards protect against a duplicate COLUMN,
 *   not a missing TABLE, so on a bare baseline they raise ER_NO_SUCH_TABLE and
 *   `node db/migrate.js` exits 1. Legacy provisioning therefore has to happen
 *   first — but as its OWN terminating step (MIGRATE_ONLY=1), not as a side
 *   effect of starting the server.
 *
 * WHY db/init.js IS NOT IN THE CHAIN BY DEFAULT
 *   server.js's autoInitDB() already applies db/schema.sql when the `users`
 *   table is absent, and does it more safely — it filters schema.sql's
 *   hardcoded `CREATE DATABASE` (which raises "Access denied" on a
 *   privilege-scoped managed credential, and would hard-fail a fail-closed
 *   chain) and `USE` (which would redirect the pool off the env-configured
 *   database). Step 1 therefore subsumes db:init for a fresh database. Set
 *   RUN_DB_INIT=1 only for a deliberate one-time bootstrap.
 * ────────────────────────────────────────────────────────────────────────── */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function runStep(label, args, extraEnv) {
  console.log('[release] ' + label);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...(extraEnv || {}) },
    stdio: 'inherit',
  });
  if (r.error) {
    console.error('[release] ' + label + ' — could not start: ' + r.error.message);
    process.exit(1);
  }
  if (r.signal) {
    console.error('[release] ' + label + ' — killed by signal ' + r.signal);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[release] ' + label + ' — FAILED (exit ' + r.status + '). Aborting: the server will NOT be started on an incomplete schema.');
    process.exit(r.status || 1);
  }
}

if (process.env.RUN_DB_INIT === '1' || process.env.RUN_DB_INIT === 'true') {
  runStep('0/3 db:init (RUN_DB_INIT is set — deliberate bootstrap)', ['db/init.js']);
} else {
  console.log('[release] 0/3 db:init — skipped (set RUN_DB_INIT=1 for a one-time bootstrap)');
}

runStep('1/3 legacy schema provisioning (MIGRATE_ONLY=1 node server.js)', ['server.js'], { MIGRATE_ONLY: '1' });
runStep('2/3 numbered migrations (node db/migrate.js)', ['db/migrate.js']);

// Step 3 — the real start. Reached ONLY if every step above exited 0.
// RELEASE_CHAIN_PROVISION_ONLY lets a test drive the whole fail-closed chain
// without leaving a server listening; it is never set in production.
if (process.env.RELEASE_CHAIN_PROVISION_ONLY === '1') {
  console.log('[release] 3/3 start — skipped (RELEASE_CHAIN_PROVISION_ONLY=1)');
  process.exit(0);
}

console.log('[release] 3/3 starting HTTP server (node server.js)');
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
// Forward termination signals so the platform can stop the app cleanly even
// though this wrapper — not node server.js — is PID 1.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { server.kill(sig); } catch (_) {} });
}
server.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
