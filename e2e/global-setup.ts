// Playwright global setup — seed master data for the procurement E2E and write
// an admin JWT (signed with the app's JWT_SECRET) to e2e/.token for the spec.
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mysql = require("mysql2/promise");
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
  const conn = await mysql.createConnection({
    host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME,
  });
  const SUP = "E2E-SUP", ITEM = "E2E-ITEM", WH = "E2E-WH";
  await conn.query("INSERT INTO warehouses (id,code,name,is_active) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)", [WH, "E2EWH", "مستودع E2E"]);
  await conn.query("INSERT INTO inv_items (id,name,kind,unit,big_unit,conv_rate,cost,stock,tracking_mode,active) VALUES (?,?,?,?,?,?,0,0,'none',1) ON DUPLICATE KEY UPDATE name=VALUES(name),active=1", [ITEM, "مادة اختبار E2E", "raw", "حبة", "كرتون", 12]);
  await conn.query("INSERT INTO suppliers (id,name,vat_number,phone,is_active,payment_terms) VALUES (?,?,?,?,1,'Net30') ON DUPLICATE KEY UPDATE is_active=1", [SUP, "مورد اختبار E2E", "300000000000003", "0500000000"]);
  await conn.end();

  const token = jwt.sign({ id: 1, username: "admin", role: "admin", name: "المدير" }, e.JWT_SECRET, { expiresIn: "3h" });
  fs.writeFileSync(path.join(process.cwd(), "e2e", ".token"), token);
}
