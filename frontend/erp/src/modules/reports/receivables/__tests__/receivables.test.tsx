// Smoke + contract tests for the receivables & collections section.
//
// The mocked payloads below are the REAL shapes the local server returns —
// captured from services/order-to-cash/O2CReportingService.js, Arabic
// `columns[].label` and Arabic row literals included, because those two traps
// are exactly what these tests exist to pin.
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";
import { ReceivablesReportPage } from "../ReceivablesReportPage";
import { ReceivablesReportsDirectory } from "../ReceivablesReportsDirectory";
import { RECEIVABLES_GROUPS, RECEIVABLES_REPORTS, receivablesReportPath } from "../registry";

const payloads: Record<string, unknown> = {
  "ar-aging": {
    success: true,
    asOf: "2026-08-15",
    columns: [
      { key: "customer_name", label: "العميل" },
      { key: "current", label: "جاري" },
      { key: "total", label: "الإجمالي" },
    ],
    data: [
      { customerId: "c1", customer_name: "شركة النور", current: 100, d1_30: 50, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0, total: 150 },
    ],
    totals: { current: 100, d1_30: 50, d31_60: 0, d61_90: 0, d91_120: 0, d120_plus: 0, total: 150 },
  },
  "sales-summary": {
    success: true,
    columns: [{ key: "metric", label: "المؤشر" }, { key: "value", label: "القيمة" }],
    data: [
      { metric: "عدد الفواتير", value: 96 },
      { metric: "صافي المبيعات", value: 4009.58 },
    ],
    totals: { net: 4009.58, returns: 0, netAfterReturns: 4009.58, total: 4561, outstanding: 0 },
  },
  collections: { success: true, columns: [], data: [], totals: { total: 0 } },
};

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: vi.fn(async (path: string) => {
        const type = path.split("/reports/")[1]?.split("?")[0] ?? "";
        return payloads[type] ?? { success: true, data: [], totals: {} };
      }),
    },
  };
});

function renderIn(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={["/reports/receivables"]}>{node}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("receivables registry", () => {
  it("covers the thirteen backed reports exactly once, all grouped", () => {
    expect(RECEIVABLES_REPORTS).toHaveLength(13);
    const grouped = RECEIVABLES_GROUPS.flatMap((g) => g.reports);
    expect([...grouped].sort()).toEqual(RECEIVABLES_REPORTS.map((r) => r.id).sort());
  });

  it("keeps every destination inside /reports/receivables and never anchors", () => {
    for (const report of RECEIVABLES_REPORTS) {
      const to = receivablesReportPath(report.id);
      expect(to).toBe(`/reports/receivables/${report.id}`);
      expect(to).not.toContain("#");
    }
  });

  it("names an ar+en label for every column and every vocabulary term", () => {
    const leaf = (dict: unknown, path: string) =>
      path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], dict);
    for (const report of RECEIVABLES_REPORTS) {
      for (const column of report.columns) {
        for (const dict of [ar, en]) {
          expect(leaf(dict, `receivablesReports.columns.${column.labelKey}`), `${report.id}/${column.key}`).toBeTypeOf("string");
        }
      }
      for (const dict of [ar, en]) {
        expect(leaf(dict, `receivablesReports.reports.${report.i18nKey}.title`), report.id).toBeTypeOf("string");
      }
    }
  });
});

describe("receivables directory", () => {
  it("lists every report a viewer may open, and hides the capability-gated one", () => {
    // No PermissionProvider in this tree, so `can()` is false for everything —
    // the one report behind `o2c.data_quality` must not be listed.
    renderIn(<ReceivablesReportsDirectory />);
    expect(screen.getByText(ar.receivablesReports.reports.arAging.title)).toBeTruthy();
    expect(screen.queryByText(ar.receivablesReports.reports.dataQuality.title)).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links.length).toBe(12);
    for (const link of links) {
      expect(link.getAttribute("href")?.startsWith("/reports/receivables/")).toBe(true);
    }
  });
});

describe("receivables report page", () => {
  it("renders OWN column labels — never the server's Arabic ones — and a server tfoot", async () => {
    renderIn(<ReceivablesReportPage reportId="ar-aging" />);
    await screen.findByText("شركة النور");

    const table = document.querySelector("[data-statement-table]") as HTMLElement;
    expect(within(table).getByText(ar.receivablesReports.columns.bucketCurrent)).toBeTruthy();
    // The server labels this column "الإجمالي" too, so assert on a header the
    // server does NOT send: proof the head came from the registry, not the wire.
    expect(within(table).getByText(ar.receivablesReports.columns.bucket31_60)).toBeTruthy();

    const foot = table.querySelector("tfoot[data-statement-totals='server']");
    expect(foot).toBeTruthy();
    expect(within(foot as HTMLElement).getByText("150.00")).toBeTruthy();
  });

  it("translates the server's Arabic row literals and formats the count row as a count", async () => {
    renderIn(<ReceivablesReportPage reportId="sales-summary" />);
    await screen.findByText(ar.receivablesReports.values.metric.invoiceCount);
    expect(screen.getByText(ar.receivablesReports.values.metric.netSales)).toBeTruthy();
    // 96 invoices is a COUNT, so it must not be money-formatted as "96.00".
    expect(screen.getByText("96")).toBeTruthy();
    expect(screen.queryByText("96.00")).toBeNull();
    // Its rows ARE the totals; a footer under them would restate one of them.
    expect(document.querySelector("tfoot[data-statement-totals='server']")).toBeNull();
  });

  it("shows an EMPTY state, not an error, when the branch scope yields no rows", async () => {
    renderIn(<ReceivablesReportPage reportId="collections" />);
    await waitFor(() => expect(document.querySelector("[data-state='empty']")).toBeTruthy());
    expect(document.querySelector("[data-state='error']")).toBeNull();
  });
});
