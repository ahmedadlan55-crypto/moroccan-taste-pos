import { beforeEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/shared/api", () => ({ apiClient: { get } }));

import { fetchReplenishmentSnapshot } from "@/modules/inventory/lib/hooks/useReplenishment";
import { fetchLotSnapshot } from "@/modules/inventory/lib/hooks/useLots";
import { fetchExpirySnapshot } from "@/modules/inventory/lib/hooks/useExpiry";

describe("complete inventory report snapshots", () => {
  beforeEach(() => { get.mockReset(); get.mockResolvedValue({ data: [], pagination: { total: 0 } }); });

  it.each([
    ["replenishment", () => fetchReplenishmentSnapshot({ warehouseId: "W1", status: "critical" }), "/inventory/v2/replenishment"],
    ["lots", () => fetchLotSnapshot({ warehouseId: "W1", risk: "expired" }), "/inventory/v2/lots"],
    ["expiry", () => fetchExpirySnapshot({ warehouseId: "W1", level: "critical" }), "/inventory/v2/expiry"],
  ])("requests the full %s snapshot instead of a visible page", async (_name, run, url) => {
    await run();
    expect(get).toHaveBeenCalledWith(url, expect.objectContaining({ params: expect.objectContaining({ snapshot: 1, warehouseId: "W1" }) }));
    const params = get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty("page");
    expect(params).not.toHaveProperty("pageSize");
  });
});
