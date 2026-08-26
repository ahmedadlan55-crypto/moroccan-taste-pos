import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

vi.mock("@/modules/reports/purchasing/PurchasingReportPage", () => ({
  PurchasingReportPage: ({ reportId }: { reportId?: string }) => (
    <output data-testid="canonical-purchasing-report">{reportId}</output>
  ),
}));

const { ProcurementReportsPage } = await import("../features/procurement/ProcurementPages");
const { PURCHASING_REPORT_IDS } = await import("@/modules/reports/purchasing/registry");

function mount(lang: "ar" | "en" = "en") {
  localStorage.setItem("erp_lang", lang);
  return render(
    <I18nProvider>
      <ProcurementReportsPage />
    </I18nProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("ProcurementReportsPage compatibility entry", () => {
  it("offers every typed procurement report and delegates rendering to the canonical engine", () => {
    mount("en");

    const nav = screen.getByRole("navigation", { name: "Purchasing sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(PURCHASING_REPORT_IDS.length);
    expect(screen.getByTestId("canonical-purchasing-report")).toHaveTextContent("ap-aging");

    const quality = nav.querySelector<HTMLButtonElement>('[data-report-id="data-quality"]');
    expect(quality).not.toBeNull();
    fireEvent.click(quality as HTMLButtonElement);

    expect(quality).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("canonical-purchasing-report")).toHaveTextContent("data-quality");
  });

  it("uses translated report labels in Arabic instead of database keys", () => {
    mount("ar");

    const nav = screen.getByRole("navigation", { name: "أقسام المشتريات" });
    const labels = within(nav).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(labels).toContain("أعمار الذمم الدائنة التشغيلية");
    expect(labels.join(" ")).not.toContain("supplier_name");
    expect(labels.join(" ")).not.toContain("data-quality");
  });
});
