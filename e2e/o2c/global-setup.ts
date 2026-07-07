// Playwright global setup for the Order-to-Cash E2E: ensure the O2C schema +
// capabilities, seed a credit customer + a POS menu item + an open admin shift,
// and write an admin JWT to e2e/o2c/.token for the specs.
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

  // Ensure O2C schema + capabilities (idempotent).
  try {
    const schema = require(path.join(process.cwd(), "db", "migrations", "order-to-cash", "schema"));
    const caps = require(path.join(process.cwd(), "db", "migrations", "order-to-cash", "capabilities"));
    await schema.apply(conn, () => {});
    await caps.seedO2CCapabilities(conn, () => {});
  } catch (err) { console.warn("[o2c-e2e] schema/caps:", (err as Error).message); }

  // A credit customer (Net30, limit 5000) for the credit-sale + AR flows.
  await conn.query(
    `INSERT INTO customers (id, name, phone, vat_number, customer_type, credit_limit, payment_terms, credit_days, is_active, created_by)
     VALUES ('E2E-CUST','عميل اختبار E2E','0555550000','300000000000003','B2B',5000,'Net30',30,1,'e2e')
     ON DUPLICATE KEY UPDATE is_active=1, credit_limit=5000, payment_terms='Net30', credit_days=30`);

  // A POS menu item so the /pos-v2 catalog is non-empty.
  await conn.query(
    `INSERT INTO menu (id, name, price, category, active, tax_category)
     VALUES ('E2E-MENU','شاي مغربي E2E',23,'مشروبات',1,'S')
     ON DUPLICATE KEY UPDATE active=1, price=23, name='شاي مغربي E2E'`);

  await conn.end();

  const token = jwt.sign({ id: 1, username: "admin", role: "admin", name: "المدير" }, e.JWT_SECRET, { expiresIn: "3h" });
  fs.writeFileSync(path.join(process.cwd(), "e2e", "o2c", ".token"), token);
}
