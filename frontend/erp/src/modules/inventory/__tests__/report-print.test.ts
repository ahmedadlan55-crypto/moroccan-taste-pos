import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/shared/api";
import { fetchReportPrintSnapshot } from "@/modules/inventory/lib/hooks/useReport";
import { ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";

vi.mock("@/shared/api", () => ({
  apiClient: { get: vi.fn() },
}));

describe("inventory report print snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue({
      data: [{ id: "ROW-1" }],
      totals: { count: 1 },
      pagination: null,
      scope: { allWarehousesAccess: false, warehouseId: "WH-1" },
      generatedAt: "2026-08-26T10:00:00.000Z",
    });
  });

  it("uses the complete print endpoint and never forwards screen pagination", async () => {
    const result = await fetchReportPrintSnapshot("valuation", "WH-1", {
      from: "2026-08-01",
      to: "2026-08-26",
      page: 7,
      pageSize: 25,
      sort: "value",
      dir: "desc",
      lang: "en",
    });

    expect(apiClient.get).toHaveBeenCalledWith("/inventory/reports/valuation/print", {
      params: expect.objectContaining({
        warehouseId: "WH-1",
        from: "2026-08-01",
        to: "2026-08-26",
        page: undefined,
        pageSize: undefined,
        sort: "value",
        dir: "desc",
        lang: "en",
      }),
    });
    expect(result.rows).toEqual([{ id: "ROW-1" }]);
    expect(result.pagination).toBeNull();
  });

  it("does not invent a warehouse id for an all-warehouses print", async () => {
    await fetchReportPrintSnapshot("stock-balance", ALL_WAREHOUSES, {});
    expect(apiClient.get).toHaveBeenCalledWith(
      "/inventory/reports/stock-balance/print",
      { params: expect.objectContaining({ warehouseId: undefined }) },
    );
  });
});
