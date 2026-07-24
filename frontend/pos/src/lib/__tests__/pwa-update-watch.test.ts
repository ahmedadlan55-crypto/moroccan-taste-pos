/**
 * Deploy watcher — the kiosk-tab update path (lib/pwa.ts).
 *
 * WHY THIS EXISTS: sw.js is network-first, so a RELOAD always picks up a new
 * deploy — but a cashier tab never reloads, and the SW only announces updates
 * when sw.js ITSELF changes. Production fixes therefore never reached
 * long-lived devices (bit us live: the combo-sync fix was deployed for hours
 * while registers kept running the old bundle and throwing version
 * conflicts). The watcher compares the entry chunk the page is EXECUTING
 * (from the served index.html's module <script>) against the entry in a
 * freshly fetched asset-manifest.json.
 *
 * Module state (status singleton) is per-import, so every test loads a fresh
 * module via vi.resetModules() + dynamic import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type PwaModule = typeof import("../pwa");

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});

async function loadPwa(): Promise<PwaModule> {
  return await import("../pwa");
}

/** A jsdom document whose shell carries the given entry <script>. */
function docWithEntry(src: string | null): Document {
  const doc = document.implementation.createHTMLDocument("pos");
  if (src !== null) {
    const s = doc.createElement("script");
    s.setAttribute("type", "module");
    s.setAttribute("src", src);
    doc.body.appendChild(s);
  }
  return doc;
}

const viteManifest = (entryFile: string) => ({
  "src/main.tsx": { file: entryFile, isEntry: true, css: ["assets/index-aaa.css"] },
  "src/chunk.ts": { file: "assets/vendor-react-bbb.js" },
});

const okJson = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

describe("manifestEntryBasename", () => {
  it("returns the hashed basename of the isEntry chunk", async () => {
    const { manifestEntryBasename } = await loadPwa();
    expect(manifestEntryBasename(viteManifest("assets/index-abc123.js"))).toBe("index-abc123.js");
  });

  it("returns null for a manifest with no entry, and for garbage input", async () => {
    const { manifestEntryBasename } = await loadPwa();
    expect(manifestEntryBasename({ "src/x.ts": { file: "assets/x-1.js" } })).toBeNull();
    expect(manifestEntryBasename(null)).toBeNull();
    expect(manifestEntryBasename("nonsense")).toBeNull();
    expect(manifestEntryBasename({ "src/x.ts": { isEntry: true } })).toBeNull();
  });
});

describe("runningEntryBasename", () => {
  it("reads the hashed basename from the served module script (absolute and relative src)", async () => {
    const { runningEntryBasename } = await loadPwa();
    expect(runningEntryBasename(docWithEntry("/pos/assets/index-abc123.js"))).toBe("index-abc123.js");
    expect(runningEntryBasename(docWithEntry("assets/index-def456.js"))).toBe("index-def456.js");
    expect(runningEntryBasename(docWithEntry("https://x.example/pos/assets/index-zzz.js"))).toBe("index-zzz.js");
  });

  it("returns null when the shell has no module script", async () => {
    const { runningEntryBasename } = await loadPwa();
    expect(runningEntryBasename(docWithEntry(null))).toBeNull();
  });
});

describe("updateAvailable", () => {
  it("is true only for two known, different basenames", async () => {
    const { updateAvailable } = await loadPwa();
    expect(updateAvailable("index-old.js", "index-new.js")).toBe(true);
    expect(updateAvailable("index-same.js", "index-same.js")).toBe(false);
    // Unknown sides must NEVER report an update — a missing manifest or an
    // unexpected shell must not trigger reloads.
    expect(updateAvailable(null, "index-new.js")).toBe(false);
    expect(updateAvailable("index-old.js", null)).toBe(false);
    expect(updateAvailable(null, null)).toBe(false);
  });
});

describe("checkForDeployedUpdate", () => {
  it("raises updateReady with the target when the served entry differs from the running one", async () => {
    const pwa = await loadPwa();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      okJson(viteManifest("assets/index-NEW.js")));
    const found = await pwa.checkForDeployedUpdate(
      fetchImpl as unknown as typeof fetch,
      docWithEntry("/pos/assets/index-OLD.js"),
    );
    expect(found).toBe(true);
    expect(pwa.getPwaStatus().updateReady).toBe(true);
    expect(pwa.getPwaStatus().updateTarget).toBe("index-NEW.js");
    // no-store: an intermediary cache serving a stale manifest would hide
    // deploys for as long as it liked.
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("stays silent when the entry matches (no update)", async () => {
    const pwa = await loadPwa();
    const fetchImpl = vi.fn(async () => okJson(viteManifest("assets/index-SAME.js")));
    const found = await pwa.checkForDeployedUpdate(
      fetchImpl as unknown as typeof fetch,
      docWithEntry("/pos/assets/index-SAME.js"),
    );
    expect(found).toBe(false);
    expect(pwa.getPwaStatus().updateReady).toBe(false);
    expect(pwa.getPwaStatus().updateTarget).toBeNull();
  });

  it("swallows network failures and non-OK responses (offline must stay quiet)", async () => {
    const pwa = await loadPwa();
    const boom = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await pwa.checkForDeployedUpdate(boom as unknown as typeof fetch, docWithEntry("/a/index-x.js"))).toBe(false);
    const notFound = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response);
    expect(await pwa.checkForDeployedUpdate(notFound as unknown as typeof fetch, docWithEntry("/a/index-x.js"))).toBe(false);
    expect(pwa.getPwaStatus().updateReady).toBe(false);
  });
});

describe("auto-reload loop guard", () => {
  it("permits one attempt per target and remembers it", async () => {
    const { autoReloadAlreadyTried, markAutoReloadTried } = await loadPwa();
    expect(autoReloadAlreadyTried("index-NEW.js")).toBe(false);
    markAutoReloadTried("index-NEW.js");
    expect(autoReloadAlreadyTried("index-NEW.js")).toBe(true);
    // A NEWER deploy is a fresh target — one fresh attempt is allowed again.
    expect(autoReloadAlreadyTried("index-NEWER.js")).toBe(false);
  });
});
