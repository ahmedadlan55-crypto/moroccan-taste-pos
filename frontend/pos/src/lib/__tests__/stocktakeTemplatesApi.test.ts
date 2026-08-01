/**
 * The template calls must unwrap the { success, data } envelope.
 *
 * THE SAME MISTAKE, TWICE IN ONE DAY. `request()` returns the RAW body
 * (`return body as T`), and this repo answers in two shapes: some routes send a
 * bare payload (GET /api/inventory/items), others the envelope
 * (routes/stocktake-templates.js `_ok`). This morning the channel catalog stored
 * the envelope as if it were the catalog and emptied the register. This
 * afternoon the same slip reached the stocktake screen — `templates.find(...)`
 * on `{ success, data }` threw «y.find is not a function», the dialog's chunk
 * boundary caught it, and the cashier saw «Couldn't open that screen».
 *
 * TypeScript cannot catch it: `request<StocktakeTemplate[]>` is an assertion
 * about a value nobody checked. So the check is a runtime one, and this pins it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStocktakeTemplate,
  deleteStocktakeTemplate,
  listStocktakeTemplates,
  updateStocktakeTemplate,
} from "../api";

const TPL = {
  id: "T1",
  name: "الجرد الأسبوعي",
  warehouseId: null,
  itemIds: ["I1", "I2"],
  items: [],
  itemCount: 2,
  createdBy: "cashier1",
  createdAt: "2026-07-28T10:00:00Z",
  canEdit: true,
  canDelete: true,
};

function stubJson(payload: unknown, status = 200) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("the envelope the server actually sends", () => {
  it("list unwraps { success, data: [...] } into an array", async () => {
    stubJson({ success: true, data: [TPL] });
    const rows = await listStocktakeTemplates();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.id).toBe("T1");
  });

  it("create unwraps { success, data: {...} } into the template", async () => {
    stubJson({ success: true, data: TPL });
    const created = await createStocktakeTemplate({ name: "x", itemIds: ["I1"] });
    expect(created.id).toBe("T1");
    expect((created as unknown as { success?: boolean }).success).toBeUndefined();
  });

  it("update unwraps too", async () => {
    stubJson({ success: true, data: { ...TPL, name: "معدّل" } });
    const updated = await updateStocktakeTemplate("T1", { name: "معدّل" });
    expect(updated.name).toBe("معدّل");
  });

  it("delete unwraps too", async () => {
    stubJson({ success: true, data: { id: "T1" } });
    expect((await deleteStocktakeTemplate("T1")).id).toBe("T1");
  });
});

describe("a shape that is neither yields a usable value, never a crash", () => {
  it("list returns [] rather than something without .find", async () => {
    // The exact production failure: a non-array reaching `templates.find(...)`
    // inside a dialog, which React turns into a blank screen.
    stubJson({ success: true });
    const rows = await listStocktakeTemplates();
    expect(rows).toEqual([]);
    expect(typeof rows.find).toBe("function");
  });

  it("list also accepts a BARE array, for a route that does not wrap", async () => {
    stubJson([TPL]);
    expect((await listStocktakeTemplates())[0]?.id).toBe("T1");
  });

  it("create returns an object rather than undefined", async () => {
    stubJson({ success: true });
    const created = await createStocktakeTemplate({ name: "x", itemIds: [] });
    expect(created).toBeTruthy();
    expect(typeof created).toBe("object");
  });
});
