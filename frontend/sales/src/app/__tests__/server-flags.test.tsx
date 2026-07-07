import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useServerFlags } from "../server-flags";
import { stubFetch } from "@/test/test-utils";

function Probe() {
  const { orderToCashEnabled, loading } = useServerFlags();
  if (loading) return <span>loading</span>;
  return <span>{orderToCashEnabled ? "ENABLED" : "DORMANT"}</span>;
}

function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
}

describe("useServerFlags (ORDER_TO_CASH gate)", () => {
  afterEach(() => { /* fetch stub reset by vitest per test */ });

  it("reports ENABLED when /api/version orderToCash=true", async () => {
    stubFetch((url) => url.includes("/api/version") ? { body: { orderToCash: true, procurementP2P: false } } : { body: {} });
    renderProbe();
    await waitFor(() => expect(screen.getByText("ENABLED")).toBeInTheDocument());
  });

  it("reports DORMANT when the flag is off (section must stay invisible)", async () => {
    stubFetch((url) => url.includes("/api/version") ? { body: { orderToCash: false } } : { body: {} });
    renderProbe();
    await waitFor(() => expect(screen.getByText("DORMANT")).toBeInTheDocument());
  });
});
