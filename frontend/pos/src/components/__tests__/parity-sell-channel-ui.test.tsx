/**
 * Parity — قنوات البيع (close/w25-sell-ui): the top-strip channel picker +
 * price-list chip, pinned against legacy app.js:
 *   channel-selector-top    #posChannelSelTop / posOnChannelTopChange (app.js:741)
 *   channel-price-list-chip «أسعار من قائمة: X» (_posRenderPriceListBadge app.js:481-505)
 *   channel-selector renders only when the owner HAS channels («الأساسي» implicit)
 * usePos is mocked (parityTestkit); App renders the strip.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeCatalog } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({
  usePos: () => currentCtx,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  isVersionConflict: () => false,
  fetchCatalog: vi.fn(),
  upsertOrder: vi.fn(),
  transition: vi.fn(),
  submitOrder: vi.fn(),
  completeOrder: vi.fn(),
  listOrders: vi.fn(async () => ({ success: true, data: [] })),
  postLegacySale: vi.fn(),
  postSync: vi.fn(),
  openShift: vi.fn(),
  findOpenShift: vi.fn(async () => null),
  closingDataV3: vi.fn(),
  closeShiftV3: vi.fn(),
  shiftSummary: vi.fn(async () => ({ success: true, data: { byStatus: {}, completedByMethod: {} } })),
  searchCustomers: vi.fn(async () => ({ success: true, data: [] })),
  getServerFlags: vi.fn(async () => ({})),
  listSales: vi.fn(async () => []),
  voidSale: vi.fn(),
  returnSale: vi.fn(),
}));

import App from "../../App";
// App renders Header/CartPanel/dialogs which resolve strings via useT(),
// which throws without an ancestor I18nProvider (see i18n/I18nProvider.tsx).
// Production main.tsx wraps App with it; tests must do the same.
import { I18nProvider } from "@/i18n/I18nProvider";

async function renderApp(ctx: PosContextValue) {
  currentCtx = ctx;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </I18nProvider>,
  );
  await act(async () => {});
  return utils;
}

beforeEach(() => cleanup());

describe("channel-selector-top — compact picker in the top strip", () => {
  it("no channels (old server) → no picker at all", async () => {
    await renderApp(makeCtx());
    expect(screen.queryByRole("combobox", { name: "قناة البيع" })).not.toBeInTheDocument();
  });

  it("channels present → picker with implicit «الأساسي» + the owner channels", async () => {
    await renderApp(
      makeCtx({
        catalog: makeCatalog({ channels: [{ id: "CH1", name: "هنقرستيشن" }, { id: "CH2", name: "جاهز" }] }),
        overrides: { channels: [{ id: "CH1", name: "هنقرستيشن" }, { id: "CH2", name: "جاهز" }] },
      }),
    );
    const picker = screen.getByRole("combobox", { name: "قناة البيع" });
    const labels = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
    expect(labels).toEqual(["الأساسي", "هنقرستيشن", "جاهز"]);
  });

  it("picking a channel calls setChannel(id); picking الأساسي calls setChannel(null)", async () => {
    const setChannel = vi.fn();
    await renderApp(
      makeCtx({
        catalog: makeCatalog({ channels: [{ id: "CH1", name: "هنقرستيشن" }] }),
        overrides: { channels: [{ id: "CH1", name: "هنقرستيشن" }], setChannel },
      }),
    );
    const picker = screen.getByRole("combobox", { name: "قناة البيع" });
    fireEvent.change(picker, { target: { value: "CH1" } });
    expect(setChannel).toHaveBeenCalledWith("CH1");
    fireEvent.change(picker, { target: { value: "" } });
    expect(setChannel).toHaveBeenCalledWith(null);
  });
});

describe("channel-price-list-chip — «أسعار من قائمة: X» when a list drives prices", () => {
  it("an item with priceSource surfaces the chip with the list name", async () => {
    const catalog = makeCatalog();
    catalog.items[0] = { ...catalog.items[0]!, priceSource: "قائمة التطبيقات" };
    await renderApp(makeCtx({ catalog }));
    expect(screen.getByText(/أسعار من قائمة:/)).toBeInTheDocument();
    expect(screen.getByText("قائمة التطبيقات")).toBeInTheDocument();
  });

  it("no priceSource anywhere → no chip", async () => {
    await renderApp(makeCtx());
    expect(screen.queryByText(/أسعار من قائمة:/)).not.toBeInTheDocument();
  });
});
