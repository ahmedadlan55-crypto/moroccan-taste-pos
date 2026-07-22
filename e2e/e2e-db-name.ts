/**
 * The ONE place that decides which database an E2E run talks to.
 *
 * This exists because the server under test and the specs reach the database by
 * two completely different routes:
 *
 *   • the server gets it from the `env` block in playwright.*.config.ts, which
 *     db/connection.js resolves as MYSQL_DATABASE first, then DB_NAME;
 *   • several specs (bilingual-flow, critical-cashier-shift, offline, o2c)
 *     open their OWN mysql2 connection and used to read `.env` off disk
 *     directly — bypassing process.env entirely.
 *
 * While both happened to land on the development database that mismatch was
 * invisible. The moment the server was pointed at an isolated clone it would
 * have become a silent, vicious bug: the spec's beforeAll would delete rows
 * and read passwords from one database while the server served another, so a
 * fixture the test had just "prepared" would not exist for the app — which
 * looks exactly like a race, or like data vanishing mid-test.
 *
 * Importing this in both places makes that class of mismatch impossible.
 */
export const E2E_DB_NAME =
  process.env.E2E_DB_NAME ||
  process.env.MYSQL_DATABASE ||
  "moroccan_taste_pos_e2e";

/**
 * Build the connection config a spec should use, given whatever it parsed out
 * of `.env` for host/port/credentials. The DATABASE always comes from here.
 */
export function e2eDbConfig(envFromDotenv: Record<string, string>) {
  return {
    host: envFromDotenv.DB_HOST || "localhost",
    port: Number(envFromDotenv.DB_PORT) || 3306,
    user: envFromDotenv.DB_USER || "root",
    password: envFromDotenv.DB_PASSWORD || "",
    database: E2E_DB_NAME,
  };
}
