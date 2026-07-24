import { execFileSync } from "child_process";
import path from "path";
import signAdminToken from "./accounting-global-setup";

/**
 * RC-gate global setup — for the rc-inventory-menu functional spec ONLY.
 *
 * That spec asserts against a deterministic synthetic dataset (2000 inv_items,
 * `RC-SKU-*`, 400 missing-English-name gaps, 80 menu rows) that lives in the
 * dedicated `moroccan_taste_pos_test` database. CO-0 repointed the ordinary ERP
 * e2e at the `moroccan_taste_pos_e2e` dev clone (19 real items), which is right
 * for the CRUD / bilingual / baseline specs but leaves this spec without its
 * data — so it runs under its own config against `_test`, seeded here.
 *
 * scripts/rc-gate-seed.mjs is hard-locked to `moroccan_taste_pos_test` and is
 * deterministic (no Math.random — reruns are byte-identical), so re-seeding on
 * every run keeps the dataset pinned. The base `admin` (id=1) user already
 * lives in `_test`, so the shared admin JWT resolves; the seed only manages its
 * own `RC-*` rows.
 */
export default async function globalSetup() {
  const seed = path.join(process.cwd(), "scripts", "rc-gate-seed.mjs");
  execFileSync(process.execPath, [seed], { stdio: "inherit" });
  await signAdminToken();
}
