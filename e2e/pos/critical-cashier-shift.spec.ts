// ═══════════════════════════════════════════════════════════════════════════
// Critical cashier flow — creation-time login + mandatory password change +
// shift-open-with-float (/pos).
//
// Exercises the FULL real path a brand-new cashier account walks on day one:
//   (1) the dedicated POS login screen (frontend/pos/src/components/PosLogin.tsx)
//       — NOT the ERP login — with a `must_change_password=1` seeded account
//   (2) the forced redirect to the shared ERP change-password screen
//       (frontend/erp/src/app/pages/ChangePassword.tsx) — a genuine cross-app
//       hop (`/pos` → `/app/change-password` → back to `/pos`)
//   (3) landing back in the POS shell with no open shift
//   (4) the header's quick-open control, which MUST open the full ShiftDialog
//       (frontend/pos/src/components/dialogs/ShiftDialog.tsx) and NEVER open a
//       shift directly — Header.tsx's own comment documents this as a fixed
//       security bug (a silent bypass would record a 0 float)
//   (5) entering an opening float on the on-screen Numpad and confirming
//   (6) the float persisted exactly (routes/shifts.js POST /open + the
//       shifts.opening_float column) and correctly folded into the CASH
//       method's EXPECTED side for accounting (routes/shifts.js
//       aggregateShiftPayments, step 3b) — never double-counted
//
// Fixture: the seeded `test.cashier` account (role cashier, branch
// SEED-BRANCH-1, warehouse E2E-WH). Its password is READ from the scratchpad
// file below at run time — never hardcoded, never printed. Because driving
// the mandatory-change flow CHANGES that password, afterAll resets the
// account to a fixed, known password (bcrypt cost 12, matching every other
// hashing call site in this codebase — see routes/auth.js) and re-flags
// must_change_password=1, then overwrites the scratchpad file with that same
// value — so this spec (and any other engineer) can run it again indefinitely
// without manual intervention. It also deletes every `shifts` row for the
// account so a re-run never collides with an already-open shift.
//
// Modeled on e2e/pos/offline.spec.ts's conventions: .env-read DB creds via
// mysql2/promise, serial mode, full afterAll teardown.
// ═══════════════════════════════════════════════════════════════════════════
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

/* eslint-disable @typescript-eslint/no-var-requires */
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

const CASHIER_USERNAME = "test.cashier";
const OPENING_FLOAT = 200;

// This file is the source of truth for the cashier's CURRENT real password
// (never hardcoded as a user secret, never logged). It is read fresh in
// beforeAll and overwritten in afterAll so the stored value always matches
// what is actually in the database.
//
// Release-Candidate gate — this used to be an ABSOLUTE path pointing into one
// particular Claude session's scratchpad directory
// (…\claude\<project>\57b1b816-a57e-4200-95f4-fc3dfbc9ef99\scratchpad\…), so
// the spec could only ever run inside that one session: every other run died
// in beforeAll with ENOENT before a single assertion executed. Confirmed
// pre-existing rather than a merge regression — the line is byte-identical on
// origin/main. An explicit E2E_ACCOUNTS_FILE wins; otherwise the handoff file
// lives in the repo's own gitignored artifacts/ directory, so it is portable
// across machines and sessions and still never committed.
const SCRATCHPAD_ACCOUNTS_FILE =
  process.env.E2E_ACCOUNTS_FILE ||
  path.join(process.cwd(), "artifacts", "e2e", "test-accounts.txt");
const CASHIER_BLOCK_MARKER = "[CASHIER (branch + warehouse)]";

// The password this spec ALWAYS resets the account back to in afterAll — a
// fixed, known, policy-compliant value (12+ chars, letter+digit+special,
// not a common password, not equal to the username). Kept in sync with the
// scratchpad file every run so the next run's beforeAll reads the same value
// this run's afterAll just wrote.
const RESET_PASSWORD = "E2eCashierReset!83Qz9";
// The password this run changes TO mid-flow (must differ from whatever the
// current password is — the server rejects a "new" password equal to the
// current one). Never persisted; afterAll always resets past it.
const NEW_PASSWORD = "E2eCashierChanged!47Xp";

function readEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  const txt = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

/** Extract the CASHIER block's current password. Never logged. */
function readCashierPassword(): string {
  const text = fs.readFileSync(SCRATCHPAD_ACCOUNTS_FILE, "utf8");
  const idx = text.indexOf(CASHIER_BLOCK_MARKER);
  if (idx === -1) throw new Error("CASHIER block not found in scratchpad accounts file");
  const block = text.slice(idx);
  const m = block.match(/password:\s*(\S+)/);
  if (!m) throw new Error("password line not found in CASHIER block");
  return m[1];
}

/** Overwrite ONLY the CASHIER block's password line, leaving every other
 *  block (custody, manager) and all commentary untouched. Best-effort: a
 *  missing marker must never throw out of afterAll. */
function writeCashierPassword(newPassword: string): void {
  fs.mkdirSync(path.dirname(SCRATCHPAD_ACCOUNTS_FILE), { recursive: true });
  // No handoff file yet (fresh machine / fresh checkout) — create one rather
  // than silently returning, which is what left the next run with nothing to
  // read.
  if (!fs.existsSync(SCRATCHPAD_ACCOUNTS_FILE)) {
    fs.writeFileSync(
      SCRATCHPAD_ACCOUNTS_FILE,
      `${CASHIER_BLOCK_MARKER}\nusername: ${CASHIER_USERNAME}\npassword: ${newPassword}\n`,
      "utf8",
    );
    return;
  }
  const original = fs.readFileSync(SCRATCHPAD_ACCOUNTS_FILE, "utf8");
  const idx = original.indexOf(CASHIER_BLOCK_MARKER);
  if (idx === -1) {
    fs.appendFileSync(
      SCRATCHPAD_ACCOUNTS_FILE,
      `\n${CASHIER_BLOCK_MARKER}\nusername: ${CASHIER_USERNAME}\npassword: ${newPassword}\n`,
      "utf8",
    );
    return;
  }
  const before = original.slice(0, idx);
  const after = original.slice(idx);
  const updatedAfter = after.replace(/(password:\s*)\S+/, `$1${newPassword}`);
  fs.writeFileSync(SCRATCHPAD_ACCOUNTS_FILE, before + updatedAfter, "utf8");
}

/**
 * Return the cashier's current password, bootstrapping if there is no usable
 * handoff file.
 *
 * Release-Candidate gate — beforeAll used to call readCashierPassword()
 * directly, so a missing file (a fresh machine, or the old hardcoded
 * foreign-session path) threw ENOENT and took down all 14 tests in this file
 * and bilingual-flow.spec.ts before anything ran. Recovery is deterministic
 * and uses machinery this spec already has: afterAll ALWAYS resets the account
 * to RESET_PASSWORD, so bootstrapping is simply performing that same reset up
 * front and recording it. No new secret is introduced — RESET_PASSWORD is
 * already a constant in this file — and the file remains the source of truth
 * from then on.
 */
async function readCashierPasswordOrBootstrap(): Promise<string> {
  try {
    return readCashierPassword();
  } catch {
    const hash = await bcrypt.hash(RESET_PASSWORD, 12);
    const [res] = await db.query(
      "UPDATE users SET password=?, must_change_password=1, password_changed_at=NULL, " +
      "failed_attempts=0, locked_until=NULL WHERE username=?",
      [hash, CASHIER_USERNAME],
    );
    if (!res || res.affectedRows === 0) {
      throw new Error(
        `No handoff file at ${SCRATCHPAD_ACCOUNTS_FILE} AND no '${CASHIER_USERNAME}' account to bootstrap. ` +
        "Create the fixture cashier first, or point E2E_ACCOUNTS_FILE at a file containing its password.",
      );
    }
    writeCashierPassword(RESET_PASSWORD);
    return RESET_PASSWORD;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let seedPassword: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const e = readEnv();
  db = await mysql.createConnection({
    host: e.DB_HOST, port: Number(e.DB_PORT), user: e.DB_USER, password: e.DB_PASSWORD, database: e.DB_NAME,
  });
  // Defensive pre-clean: a prior crashed run must never block this one with a
  // leftover OPEN shift for the fixture cashier.
  await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);
  // Read the account's CURRENT real password — never hardcoded, never logged.
  // Bootstraps itself if there is no usable handoff file yet (see the helper).
  seedPassword = await readCashierPasswordOrBootstrap();
});

test.afterAll(async () => {
  try {
    if (db) {
      const hash = await bcrypt.hash(RESET_PASSWORD, 12);
      // Deliberately NOT touching token_version here (see report: REAL BUG in
      // lib/sessionVersion.js). That module caches each user's token_version
      // in-process for 15s (TOKEN_VERSION_CACHE_MS) and is only invalidated by
      // an explicit sessionVersion.bump(userId) call from inside the running
      // server (routes/auth.js's own /change-password handler does this). A
      // raw SQL bump from an external process (this teardown, an admin script,
      // a support tool — anything outside that one route) cannot reach that
      // in-memory cache, so the very next login + authenticated request for
      // this user can spuriously 401 with "انتهت الجلسة" for up to 15s even
      // though the fresh token's tokenVersion claim exactly matches the new DB
      // value. Leaving token_version untouched here (it was already correctly
      // bumped+cached by the in-app change-password call this test just made)
      // avoids re-triggering that staleness window on the NEXT run.
      await db.query(
        "UPDATE users SET password=?, must_change_password=1, password_changed_at=NULL, " +
        "failed_attempts=0, locked_until=NULL WHERE username=?",
        [hash, CASHIER_USERNAME],
      );
      await db.query("DELETE FROM shifts WHERE username = ?", [CASHIER_USERNAME]);
    }
  } finally {
    if (db) await db.end();
    // Keep the scratchpad file in sync with the DB regardless of DB outcome —
    // best-effort, never throws.
    try { writeCashierPassword(RESET_PASSWORD); } catch { /* best-effort */ }
  }
});

test("cashier creation + login + shift-open-with-float", async ({ page, request }, testInfo) => {
  // ── Hygiene listeners — attached BEFORE any navigation, per this project's
  //    "zero console errors / zero 4xx+5xx, no whitelist" convention. ──────
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const badResponses: Array<{ url: string; status: number }> = [];
  page.on("response", (res) => {
    if (res.status() >= 400) badResponses.push({ url: res.url(), status: res.status() });
  });

  // ── (1) fresh /pos/ — clear any stale session so PosLogin actually renders ──
  await page.goto("/pos/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.getByLabel("اسم المستخدم")).toBeVisible({ timeout: 30_000 });

  // ── (2) real login through the DEDICATED POS screen (not the ERP one) ──────
  await page.getByLabel("اسم المستخدم").fill(CASHIER_USERNAME);
  await page.getByLabel("كلمة المرور").fill(seedPassword);
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();

  // ── (3) forced redirect to the shared ERP change-password screen ───────────
  await page.waitForURL(/\/app\/change-password/, { timeout: 20_000 });
  const changePwUrl = new URL(page.url());
  expect(changePwUrl.pathname).toBe("/app/change-password");
  expect(changePwUrl.searchParams.get("must")).toBe("1");
  expect(changePwUrl.searchParams.get("redirect")).toBe("/pos/");

  // ── (4) complete the mandatory change ───────────────────────────────────────
  // NOTE: ChangePassword.tsx's <Field> renders its <label htmlFor> against an
  // id that the plain (non-render-prop) <Input> children never receive — the
  // labels are NOT programmatically associated with their inputs (a real a11y
  // defect; see the report). getByLabel cannot find these fields, so the
  // inputs are targeted by their (still-correct) autocomplete attributes.
  const currentPwInput = page.locator('input[autocomplete="current-password"]');
  const newPwInput = page.locator('input[autocomplete="new-password"]').first();
  const confirmPwInput = page.locator('input[autocomplete="new-password"]').last();
  await expect(currentPwInput).toBeVisible({ timeout: 20_000 });
  await currentPwInput.fill(seedPassword);
  await newPwInput.fill(NEW_PASSWORD);
  await confirmPwInput.fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "حفظ كلمة المرور", exact: true }).click();

  // ── (5) must land back in the REAL POS till, not an ERP page ────────────────
  // KNOWN REAL BUG (see report): ChangePassword.tsx calls react-router's
  // `navigate(redirect)` inside a <BrowserRouter basename="/app">. React
  // Router resolves an absolute-looking target ("/pos/") RELATIVE TO THAT
  // BASENAME, so the browser actually lands on "/app/pos/" — a path with no
  // matching ERP route, which falls through to the ERP's catch-all NotFound
  // route. The cashier who was forced through the mandatory password change
  // never actually gets back to the till. This assertion is left STRICT
  // (soft, so the rest of the mandated flow below can still be exercised and
  // reported honestly) — it is expected to FAIL until ChangePassword.tsx is
  // fixed to `window.location.assign(redirect)` for cross-app targets, the
  // same technique PosLogin.tsx already uses for the opposite hop.
  // Wait for the app to actually finish navigating away from change-password
  // (never race a fixed sleep against an async fetch + client-side navigate —
  // the submit's POST can legitimately take longer than a guessed timeout).
  await page.waitForURL((url) => !/\/change-password/.test(url.pathname), { timeout: 20_000 });
  const landedPathname = new URL(page.url()).pathname;
  expect.soft(
    landedPathname,
    "REAL BUG: ChangePassword.tsx's navigate(redirect) is basename-relative " +
    "(BrowserRouter basename=\"/app\"), so redirect=/pos/ actually lands on " +
    "/app/pos/ (ERP NotFound), not the real /pos/ POS till. Fix: use " +
    "window.location.assign for a cross-app redirect target.",
  ).toBe("/pos/");

  // Recover from the documented bug so the REST of the mandated flow (the
  // shift-open regression this task exists to prove) still gets real coverage
  // in this same run, exactly like a cashier manually navigating back would.
  if (landedPathname !== "/pos/") {
    await page.goto("/pos/");
  }

  // ── (6) POS shell renders, authenticated as the cashier, no open shift ──────
  const header = page.getByTestId("pos-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("cashier-identity")).toHaveText(CASHIER_USERNAME);

  const [preOpenShifts] = await db.query(
    "SELECT id FROM shifts WHERE username = ? AND status = 'OPEN'", [CASHIER_USERNAME],
  );
  expect(preOpenShifts, "no open shift before the quick-open click").toHaveLength(0);

  const quickOpenBtn = header.getByRole("button", { name: "فتح وردية", exact: true });
  await expect(quickOpenBtn).toBeVisible();

  // ── (7) THE REGRESSION CHECK — quick-open must open the FULL dialog, ───────
  //    never bypass straight to opening a shift (a previously-fixed security bug).
  await quickOpenBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("لا توجد وردية مفتوحة")).toBeVisible();
  await expect(dialog.getByTestId("numpad")).toBeVisible();

  // Prove the click did NOT silently open a shift behind the dialog.
  const [stillNoShift] = await db.query(
    "SELECT id FROM shifts WHERE username = ? AND status = 'OPEN'", [CASHIER_USERNAME],
  );
  expect(stillNoShift, "dialog opened WITHOUT creating a shift").toHaveLength(0);

  // ── (8) enter the opening float via the on-screen Numpad ───────────────────
  for (const digit of ["اثنان", "صفر", "صفر"]) {
    await dialog.getByRole("button", { name: digit, exact: true }).click();
    await page.waitForTimeout(80);
  }
  await expect(dialog.getByText("200.00 ر.س")).toBeVisible();

  // ── (9) confirm — the shift opens with that exact float ─────────────────────
  await dialog.getByRole("button", { name: "فتح وردية", exact: true }).click();
  await expect(dialog.getByText("الوردية الحالية")).toBeVisible({ timeout: 15_000 });

  const [openedShifts] = await db.query(
    "SELECT id, status, opening_float FROM shifts WHERE username = ? AND status = 'OPEN'",
    [CASHIER_USERNAME],
  );
  expect(openedShifts, "exactly one OPEN shift after confirming").toHaveLength(1);
  const shiftId: string = openedShifts[0].id;
  expect(Number(openedShifts[0].opening_float)).toBe(OPENING_FLOAT);

  // ── (10) accounting correctness — the float folds into CASH's EXPECTED ─────
  //    side exactly once (never double-counted). No sales happened in this
  //    shift, so the entire expected total must equal the float itself.
  const token = await page.evaluate(() => localStorage.getItem("pos_token"));
  const closingRes = await request.get(`/api/shifts/closing-data-v3/${shiftId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(closingRes.ok()).toBe(true);
  const closingData = await closingRes.json();
  expect(Number(closingData.openingFloat)).toBe(OPENING_FLOAT);
  expect(Number(closingData.expectedTotal)).toBe(OPENING_FLOAT);
  const cashMethod = (closingData.methods as Array<{ groupType: string; expectedAmount: number }>).find(
    (m) => m.groupType === "cash",
  );
  expect(cashMethod, "a cash payment method exists in the closing data").toBeTruthy();
  expect(Number(cashMethod!.expectedAmount)).toBe(OPENING_FLOAT);

  // ── close the dialog, confirm the shell now shows the open shift chip ───────
  await dialog.getByRole("button", { name: "إغلاق", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(header.getByRole("button", { name: /وردية/ })).toBeVisible();
  await expect(quickOpenBtn).toBeHidden();

  // ── full-page screenshot proof, one per viewport project ───────────────────
  const artifactsDir = path.join(process.cwd(), "artifacts", "e2e", "pos", "critical-flows");
  fs.mkdirSync(artifactsDir, { recursive: true });
  await page.screenshot({
    path: path.join(artifactsDir, `critical-cashier-shift-${testInfo.project.name}.png`),
    fullPage: true,
  });

  // ── hygiene assertions — zero console errors, zero 4xx/5xx, no whitelist ───
  // KNOWN REAL BUG (see report): frontend/pos/src/App.tsx's refreshHeldCount
  // effect is not gated on `user` — it runs unconditionally on every mount, so
  // the very first, still-unauthenticated render of the POS login screen
  // fires a background GET /api/pos/v2/orders?status=held with no token,
  // which the server correctly 401s (fail-closed, no data leak, silently
  // swallowed by the caller's try/catch — a cashier never sees this). It is
  // real background noise nonetheless, and this is the first spec in this
  // suite to exercise a genuinely fresh, unauthenticated PosLogin render
  // (every other spec pre-seeds a valid token before first paint). Left
  // strict, per this project's "zero console errors / zero 4xx+, no
  // whitelist" convention — expected to fail until App.tsx gates that effect
  // on `user`.
  expect(consoleErrors, `console errors seen during the flow: ${JSON.stringify(consoleErrors)}`).toHaveLength(0);
  expect(badResponses, `4xx/5xx responses seen during the flow: ${JSON.stringify(badResponses)}`).toHaveLength(0);
});
