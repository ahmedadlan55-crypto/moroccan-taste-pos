import provisionE2eDb from "./e2e-db-global-setup";
import signAdminToken from "./accounting-global-setup";

/**
 * ERP global setup — composite, because Playwright allows exactly one.
 *
 * Order matters: the database clone must exist BEFORE the admin JWT is signed
 * and used, since the token's identity has to resolve against the users table
 * the server will actually be reading. Provisioning also drops and recreates
 * the target, so signing first would leave the token pointing at a database
 * that is about to be replaced.
 */
export default async function globalSetup() {
  provisionE2eDb();
  await signAdminToken();
}
