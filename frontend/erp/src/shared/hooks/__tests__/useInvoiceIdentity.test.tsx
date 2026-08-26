// The letterhead reader.
//
// The things worth pinning are not "does it fetch":
//
//   1. THE SOURCE. It reads the narrow public-branding endpoint, and NOT
//      `/settings/invoice-identity`, which requires admin|manager. An earlier
//      attempt widened that endpoint's guard so an accountant could print a
//      letterhead — an access-control change to a live route, in service of a
//      reports feature, that nobody asked for. It was reverted. This test is
//      what stops it coming back: if the endpoint moves, this fails.
//
//   2. THE DEGRADED PATH. Get it wrong and a failed branding read takes down
//      every printed report in the product. PrintDocument sits at the top of
//      ~20 screens, and many of their unit tests render it with no
//      QueryClientProvider at all.
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

import { apiClient } from "@/shared/api";
import { companyIdentityQueryKey, useInvoiceIdentity, type SettingsMap } from "../useInvoiceIdentity";

const get = apiClient.get as Mock;

/** The shape the public branding endpoint returns. */
function settings(overrides: SettingsMap = {}): SettingsMap {
  return {
    CompanyName: "شركة المذاق المغربي للتجارة",
    TaxNumber: "310122393500003",
    CrNumber: "1010101010",
    NationalAddress: "الرياض",
    Currency: "SAR",
    ...overrides,
  };
}

function withClient(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  get.mockReset();
});

describe("the source is the narrow endpoint every role can read", () => {
  it("reads public branding — never the full or manager-gated settings maps", async () => {
    get.mockResolvedValue(settings());
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.entityName).not.toBe(""));

    expect(get).toHaveBeenCalled();
    const path = String(get.mock.calls[0][0]);
    expect(path).toBe("/settings/public-branding");
    expect(path).not.toBe("/settings");
    expect(
      path,
      "the manager-gated endpoint 403s the accountant who actually prints statements",
    ).not.toContain("invoice-identity");
  });

  it("uses its own cache key, not the editor's", () => {
    // The editor's ["erp","invoice-identity",branchId,brandId] key means the
    // SCOPED endpoint's envelope. Pointing a different request at that key would
    // make one key stand for two different response bodies.
    expect(companyIdentityQueryKey()).toEqual(["erp", "company-identity"]);
  });
});

describe("what it reads off the settings map", () => {
  it("maps CompanyName and TaxNumber onto the letterhead", async () => {
    get.mockResolvedValue(settings());
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.entityName).toBe("شركة المذاق المغربي للتجارة");
    expect(result.current.taxNumber).toBe("310122393500003");
    expect(result.current.identity?.crNumber).toBe("1010101010");
    expect(result.current.isUnavailable).toBe(false);
  });

  it("trims — a stray space in a settings row must not shift the masthead", async () => {
    get.mockResolvedValue(settings({ CompanyName: "  شركة المذاق  ", TaxNumber: " 3101 " }));
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entityName).toBe("شركة المذاق");
    expect(result.current.taxNumber).toBe("3101");
  });

  it("a VAT number with no company name is NOT an identity", async () => {
    // Printing a bare tax number under a report title reads as a stray figure.
    get.mockResolvedValue(settings({ CompanyName: "" }));
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.identity).toBeNull();
    expect(result.current.taxNumber).toBe("");
    expect(result.current.isUnavailable).toBe(true);
  });

  it("a missing VAT number still yields a letterhead — the name is the issuer", async () => {
    get.mockResolvedValue(settings({ TaxNumber: undefined }));
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.entityName).not.toBe("");
    expect(result.current.taxNumber).toBe("");
  });
});

describe("degradation — a report must print", () => {
  it("a failed read yields null, not a throw and not a fabricated seller", async () => {
    get.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.identity).toBeNull();
    expect(result.current.entityName).toBe("");
    expect(result.current.isUnavailable).toBe(true);
  });

  it("renders with NO QueryClientProvider instead of throwing", () => {
    // useQueryClient() throws here. That would turn "no letterhead" into
    // "the whole report crashed" on every screen whose test omits the provider.
    expect(() => renderHook(() => useInvoiceIdentity())).not.toThrow();
    const { result } = renderHook(() => useInvoiceIdentity());
    expect(result.current.identity).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("issues no request when disabled", async () => {
    get.mockResolvedValue(settings());
    renderHook(() => useInvoiceIdentity({ enabled: false }), { wrapper: withClient(newClient()) });
    await new Promise((r) => setTimeout(r, 0));
    expect(get).not.toHaveBeenCalled();
  });

  it("does not retry — one failure must not repeat behind every printed page", async () => {
    get.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useInvoiceIdentity(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(get).toHaveBeenCalledTimes(1);
  });
});
