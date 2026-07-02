import { type ReactElement, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WarehouseScopeProvider } from "@/app/warehouse-scope-provider";
import { vi } from "vitest";

// A QueryClient with retries OFF so error states surface immediately in tests.
export function makeTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactElement, opts: { route?: string; client?: QueryClient } = {}) {
  const client = opts.client ?? makeTestClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>
        <WarehouseScopeProvider>{children}</WarehouseScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}

// ── fetch stubbing ───────────────────────────────────────────────────────
export interface StubReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export type FetchHandler = (url: string, init?: RequestInit) => StubReply | Promise<StubReply>;

function makeResponse(reply: StubReply): Response {
  const status = reply.status ?? 200;
  const headers = new Headers({ "content-type": "application/json", ...(reply.headers ?? {}) });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => reply.body,
    text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)),
  } as unknown as Response;
}

/** Replace global.fetch with a handler. Returns the vi mock for assertions. */
export function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // honor abort
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const reply = await handler(url, init);
    return makeResponse(reply);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
