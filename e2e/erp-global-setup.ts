import signAdminToken from "./accounting-global-setup";

/**
 * ERP global setup — now ONLY signs the admin JWT.
 *
 * DB provisioning used to happen here too, but Playwright starts the webServer
 * BEFORE globalSetup (createGlobalSetupTasks lists the WebServerPlugin ahead of
 * globalSetups), so cloning here dropped and recreated `_e2e` out from under the
 * already-booted server and wiped its boot migrations — the whole-suite
 * `warehouses` 422. Provisioning moved into the webServer command
 * (scripts/e2e/provision-and-serve.js) so the clone exists before `node
 * server.js` migrates it.
 *
 * Signing the token needs no database: accounting-global-setup.ts reads
 * JWT_SECRET from the environment / .env and signs `{ id:1, tokenVersion:1 }`
 * locally. Its validity is checked against users.token_version at REQUEST time,
 * by which point the webServer has already provisioned and migrated the clone.
 */
export default async function globalSetup() {
  await signAdminToken();
}
