import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { NAV, NAV_ITEMS, canAccessNavItem } from "@/app/navigation/manifest";
import { ALL_CAPS, ROLE_GRANTS, can } from "@/app/permissions";
import { ROUTE_PATHS, REDIRECT_PATHS, SUBROUTE_BASE_PATHS } from "@/app/router";

// ── Anti-duplication / integrity harness ────────────────────────────────────
// The unified app has ONE nav manifest, ONE permission catalog and ONE router.
// These tests fail loudly the moment those drift apart, so no duplicate route /
// nav id / permission key can slip in, and no screen can depend on the legacy
// erp.js globals.

describe("navigation manifest integrity", () => {
  it("every nav item id is unique", () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("every nav item path is unique", () => {
    const paths = NAV_ITEMS.map((i) => i.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes).toEqual([]);
  });

  it("every nav group id is unique", () => {
    const ids = NAV.map((g) => g.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("homes the sales decision center with sales documents and gates it on analytics", () => {
    const sales = NAV.find((group) => group.id === "sales");
    const reports = NAV.find((group) => group.id === "reports");
    expect(sales?.items[0]).toMatchObject({
      id: "rp-sales",
      path: "/reports/sales",
      cap: "analytics.view",
    });
    expect(reports?.items.some((item) => item.id === "rp-sales")).toBe(false);
  });

  it("every nav item has a capability from the ONE catalog", () => {
    const caps = new Set<string>(ALL_CAPS);
    const offenders = NAV_ITEMS.filter((i) => !i.cap || !caps.has(i.cap));
    expect(offenders.map((i) => `${i.id} (${i.cap ?? "no cap"})`)).toEqual([]);
  });

  it("warehouse intelligence uses the server's finance-or-procurement union and excludes cashier", () => {
    const items = NAV_ITEMS.filter((item) => item.id === "rp-inventory" || item.id === "rp-purchasing");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.capsAny).toEqual(["finance.reports.view", "procurement.reports"]);
      expect(canAccessNavItem(item, (cap) => cap === "procurement.reports")).toBe(true);
      expect(canAccessNavItem(item, (cap) => cap === "finance.reports.view")).toBe(true);
      expect(canAccessNavItem(item, () => false)).toBe(false);
      expect(can({ username: "cash", role: "cashier" }, "finance.reports.view")).toBe(false);
      expect(can({ username: "cash", role: "cashier" }, "procurement.reports")).toBe(false);
    }
  });
});

describe("permission catalog integrity", () => {
  it("every catalog capability has a role grant", () => {
    const missing = ALL_CAPS.filter(
      (cap) => !Object.prototype.hasOwnProperty.call(ROLE_GRANTS, cap),
    );
    expect(missing).toEqual([]);
  });

  it("catalog capabilities are unique", () => {
    const dupes = ALL_CAPS.filter((c, i) => ALL_CAPS.indexOf(c) !== i);
    expect(dupes).toEqual([]);
  });
});

describe("router ↔ manifest coverage", () => {
  it("every nav path has a registered route", () => {
    const missing = NAV_ITEMS.map((i) => i.path).filter((p) => !ROUTE_PATHS.has(p));
    expect(missing).toEqual([]);
  });

  it("no route exists without a nav item, an allowlisted redirect, or a sub-route home", () => {
    // A registered route is legitimate when it is a manifest path, an allowlisted
    // redirect, OR it is (or lives under) a subtree-owning item's base path — the
    // `<base>/*` splats belong to their base item, not orphans. Anything else (a
    // route with no home) still fails loudly, preserving the test's real purpose.
    const navPaths = new Set(NAV_ITEMS.map((i) => i.path));
    const bases = [...SUBROUTE_BASE_PATHS];
    const underSubRoute = (p: string) => bases.some((b) => p === b || p.startsWith(`${b}/`));
    const orphans = [...ROUTE_PATHS].filter(
      (p) => !navPaths.has(p) && !REDIRECT_PATHS.has(p) && !underSubRoute(p),
    );
    expect(orphans).toEqual([]);
  });
});

// ── Source scan — bans on legacy coupling / unsafe HTML ──────────────────────
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["__tests__", "node_modules", "dist", "assets"]);

function collectSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectSources(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(abs);
    }
  }
}

describe("no legacy coupling in erp source", () => {
  const files: string[] = [];
  collectSources(SRC_DIR, files);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no file references window.erp*", () => {
    const offenders = files.filter((f) => /window\.erp/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it("no file imports the legacy erp.js", () => {
    const offenders = files.filter((f) => /['"][^'"]*erp\.js['"]/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });

  it("no file uses dangerouslySetInnerHTML", () => {
    const offenders = files.filter((f) => /dangerouslySetInnerHTML/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC_DIR, f))).toEqual([]);
  });
});

describe("full-page workflow integrity", () => {
  const workflowFiles: string[] = [];
  collectSources(SRC_DIR, workflowFiles);
  const drawerSource = readFileSync(path.join(SRC_DIR, "shared", "ui", "drawer.tsx"), "utf8");
  const dialogSource = readFileSync(path.join(SRC_DIR, "shared", "ui", "dialog.tsx"), "utf8");
  const confirmSource = readFileSync(path.join(SRC_DIR, "shared", "ui", "confirm-dialog.tsx"), "utf8");
  const alertSource = readFileSync(path.join(SRC_DIR, "shared", "ui", "alert-dialog.tsx"), "utf8");

  it("the legacy Drawer API cannot render a side panel", () => {
    expect(drawerSource).toContain("FullPageFlow");
    expect(drawerSource).not.toMatch(/right-0|translateX|x:\s*["']100%/);
  });

  it("normal dialogs default to a full-page workspace", () => {
    expect(dialogSource).toContain('presentation = "workspace"');
    expect(dialogSource).toContain("FullPageFlow");
  });

  it("short confirmation primitives remain explicitly compact", () => {
    expect(confirmSource).toContain('presentation="compact"');
    expect(alertSource).toContain('presentation="compact"');
  });

  it("business modules do not hand-build full-screen overlays", () => {
    const moduleRoot = `${path.sep}modules${path.sep}`;
    const allowed = `${path.sep}inventory${path.sep}features${path.sep}_shared${path.sep}ReasonDialog.tsx`;
    const offenders = workflowFiles.filter((file) => {
      if (!file.includes(moduleRoot) || file.endsWith(allowed)) return false;
      return /fixed\s+inset-0/.test(readFileSync(file, "utf8"));
    });
    expect(offenders.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });
});
