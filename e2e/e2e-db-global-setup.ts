import { execFileSync } from "child_process";
import path from "path";

/**
 * Provision the isolated E2E database before any spec runs.
 *
 * Until this existed, both Playwright configs launched `node server.js` with no
 * DB_NAME override, so every E2E run — the 104-leaf closure gate, the POS sell
 * flow, the RBAC specs, every screenshot — wrote to the REAL development
 * database. Three consequences, all of which cost real debugging time:
 *
 *   • the gate could not honestly claim "zero writes to the development
 *     database", because it wrote to it constantly;
 *   • the POS visual baselines photographed a live product catalog, so they
 *     drifted for reasons that had nothing to do with the UI and could not be
 *     told apart from a genuine visual regression;
 *   • state accumulated across runs, so a spec could legitimately pass alone
 *     and fail in the suite — which is exactly the shape of failure that is
 *     hardest to diagnose and easiest to wave away as "flaky".
 *
 * Cloning fresh here makes every run start from an identical, known snapshot,
 * and confines everything a test writes to a database that is dropped and
 * recreated next time. The development database is only ever read.
 *
 * Set E2E_SKIP_DB_PROVISION=1 to reuse the existing clone — useful when
 * iterating on a single spec, never in a gate run.
 */
export default function globalSetup() {
  if (process.env.E2E_SKIP_DB_PROVISION === "1") {
    console.log("[e2e-db] provisioning SKIPPED (E2E_SKIP_DB_PROVISION=1) — reusing the existing clone");
    return;
  }
  const script = path.join(process.cwd(), "scripts", "e2e", "provision-e2e-db.js");
  execFileSync(process.execPath, [script], { stdio: "inherit", timeout: 600_000 });
}
