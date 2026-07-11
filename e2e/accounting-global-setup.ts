// Global setup for the accounting baseline-screenshot run.
//
// Deliberately MINIMAL — unlike e2e/global-setup.ts it performs NO DB seeding
// (the Stage C demo data is seeded separately by scripts/stage-c-demo-seed.mjs,
// tagged reference_type='STAGECDEMO' for later cleanup). It only signs an
// admin JWT with the app's JWT_SECRET from .env and writes it to e2e/.token
// for the spec's localStorage auto-login.
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jwt = require("jsonwebtoken");

function readEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
}

export default async function globalSetup() {
  const e = readEnv();
  if (!e.JWT_SECRET) throw new Error("JWT_SECRET missing from .env");
  // tokenVersion:1 matches users.token_version for the local admin (id=1) —
  // required by the session-version gate in server.js / lib/sessionVersion.js.
  const token = jwt.sign(
    { id: 1, username: "admin", role: "admin", name: "المدير", tokenVersion: 1 },
    e.JWT_SECRET,
    { expiresIn: "3h" }
  );
  fs.writeFileSync(path.join(process.cwd(), "e2e", ".token"), token);
}
