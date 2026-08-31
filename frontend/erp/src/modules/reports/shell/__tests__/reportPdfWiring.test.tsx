// Server-side PDF, wired once for every report shell.
//
// ─── WHAT WENT WRONG THE FIRST TIME ─────────────────────────────────────────
// PDF was implemented inside ONE report shell. The product has six, plus a
// `ReportHeader` that eleven accounting and receivables statements render — so
// the feature shipped and almost no report could produce a PDF. The fix was to
// move the capability probe, the capture, the 503 fallback and the busy state
// into one hook and offer it from the shared header.
//
// ─── THE CONTRACT THAT MATTERS MOST ─────────────────────────────────────────
// `printDisabled` exists because a statement whose source FAILED still has a
// page around it — header, filters, buttons — and a printed sheet of an errored
// report is indistinguishable from a real one once it leaves the screen. A PDF
// button that ignored that block would reintroduce the exact defect the block
// exists to prevent, one button over. So PDF is disabled wherever print is.
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";
import { ReportHeader } from "@/modules/accounting/components";

// The capability probe and the renderer both go over the wire; drive them.
const { state } = vi.hoisted(() => ({
  state: { available: true, calls: [] as unknown[], status: 200 },
}));

vi.mock("@/shared/lib/downloadPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/downloadPdf")>();
  return {
    ...actual,
    pdfAvailable: vi.fn(async () => state.available),
    downloadReportPdf: vi.fn(async (request: unknown) => { state.calls.push(request); return true; }),
    capturePrintDocument: vi.fn(() => "<table><tr><td>قيمة</td></tr></table>"),
  };
});

function renderHeader(props: Record<string, unknown>) {
  return render(
    <I18nProvider>
      <ReportHeader title="قائمة المركز المالي" onPrint={() => {}} {...props} />
    </I18nProvider>,
  );
}

/** The PDF button, or null. Identified by its label, like a user would. */
function pdfButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /PDF/i });
}

describe("report PDF wiring", () => {
  beforeEach(() => { state.available = true; state.calls = []; });
  afterEach(cleanup);

  it("offers no PDF button to a header that did not ask for one", async () => {
    renderHeader({});
    // Wait for the probe to have had every chance to resolve, so this asserts
    // "never appears" rather than "has not appeared yet".
    await waitFor(() => expect(screen.getByRole("button", { name: /طباعة|Print/i })).toBeTruthy());
    expect(pdfButton()).toBeNull();
  });

  it("offers one when the report asks and the host can render", async () => {
    renderHeader({ pdf: { filename: "balance-sheet" } });
    await waitFor(() => expect(pdfButton()).not.toBeNull());
  });

  it("offers none when the host has no renderer, rather than one that fails", async () => {
    state.available = false;
    renderHeader({ pdf: { filename: "balance-sheet" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /طباعة|Print/i })).toBeTruthy());
    expect(pdfButton()).toBeNull();
  });

  it("BLOCKS PDF on a report that must not print", async () => {
    // The whole point: a failed source disables print, and PDF is simply
    // another way to put the same wrong sheet on paper.
    renderHeader({ pdf: { filename: "balance-sheet" }, printDisabled: true });
    await waitFor(() => expect(pdfButton()).not.toBeNull());
    expect((pdfButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /طباعة|Print/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the report's own filename and orientation, not a default", async () => {
    renderHeader({ pdf: { filename: "trial-balance", landscape: true } });
    await waitFor(() => expect(pdfButton()).not.toBeNull());
    fireEvent.click(pdfButton() as HTMLElement);
    await waitFor(() => expect(state.calls.length).toBe(1));
    const sent = state.calls[0] as { filename: string; landscape: boolean; title: string };
    expect(sent.filename).toBe("trial-balance");
    // A wide statement printed portrait loses its right-hand columns, and it
    // loses them silently — nothing errors, the sheet is just wrong.
    expect(sent.landscape).toBe(true);
    expect(sent.title).toBe("قائمة المركز المالي");
  });
});
