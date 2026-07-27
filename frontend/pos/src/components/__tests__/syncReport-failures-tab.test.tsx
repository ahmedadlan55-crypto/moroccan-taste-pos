/**
 * dialogs/SyncReportDialog — the second tab: the DURABLE failure log.
 *
 * The first tab renders `engineStatus.lastReport`, which lives in memory on the
 * engine singleton: the next flush overwrites it and any reload erases it. So
 * the only record that a queued sale failed permanently was gone by the time a
 * shift manager came looking. This tab reads lib/failureLog.ts instead, which
 * is on disk.
 *
 * It is a TAB and not a new dialog on purpose: App.tsx's `overlayOpen` union
 * gates F2/F4/F9 and the idle PWA auto-reload, and `syncOpen` is already a term
 * of it. A fourteenth overlay would have needed a fourteenth term.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { __resetFailureLogCacheForTests, readFailures, recordFailure } from "@/lib/failureLog";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeFakeEngine } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

import { SyncReportDialog } from "../dialogs/SyncReportDialog";
import { I18nProvider } from "@/i18n/I18nProvider";

async function renderDialog(opts: { supervisor?: boolean } = {}) {
  const engine = makeFakeEngine();
  currentCtx = makeCtx({ engine, supervisor: opts.supervisor ?? false });
  const utils = render(
    <I18nProvider>
      <SyncReportDialog open onClose={vi.fn()} />
    </I18nProvider>,
  );
  // Flush the queued-ops fetch so its setState doesn't land outside act().
  await act(async () => {});
  return utils;
}

function openFailuresTab() {
  fireEvent.click(screen.getByRole("tab", { name: /سجل الإخفاقات/ }));
}

beforeEach(() => {
  localStorage.clear();
  __resetFailureLogCacheForTests();
});
afterEach(() => cleanup());

describe("the tab itself", () => {
  it("opens on the sync tab, and switching reveals the log", async () => {
    await renderDialog();
    expect(screen.getByRole("tab", { name: "المزامنة" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("sync-report-failures")).not.toBeInTheDocument();

    openFailuresTab();
    expect(screen.getByTestId("sync-report-failures")).toBeInTheDocument();
  });

  it("badges the tab with the number of recorded failures", async () => {
    recordFailure({ id: "checkout:A", kind: "checkout", message: "خطأ ١" });
    recordFailure({ id: "checkout:B", kind: "checkout", message: "خطأ ٢" });
    await renderDialog();
    expect(screen.getByRole("tab", { name: /سجل الإخفاقات/ })).toHaveTextContent("2");
  });

  it("says nothing is wrong when nothing is wrong", async () => {
    await renderDialog();
    openFailuresTab();
    expect(screen.getByText("لا إخفاقات مسجّلة")).toBeInTheDocument();
  });
});

describe("what a manager actually reads", () => {
  it("shows which sale, why, how much and who", async () => {
    recordFailure({
      id: "checkout:01ORDER",
      kind: "checkout",
      orderId: "01ORDERABCDEF123456",
      message: "الوردية مغلقة — تعذّر تسجيل البيع",
      code: "SHIFT_CLOSED",
      total: 132.25,
      cashier: "cashier1",
    });
    await renderDialog();
    openFailuresTab();

    expect(screen.getByText("الوردية مغلقة — تعذّر تسجيل البيع")).toBeInTheDocument();
    expect(screen.getByText("SHIFT_CLOSED")).toBeInTheDocument();
    expect(screen.getByText("132.25")).toBeInTheDocument();
    expect(screen.getByText(/cashier1/)).toBeInTheDocument();
    expect(screen.getByText("بيع")).toBeInTheDocument(); // kind label
  });

  it("labels a legacy-drain failure distinctly from a checkout one", async () => {
    recordFailure({ id: "legacy:C-9", kind: "legacy-drain", reference: "C-9", message: "رفض الخادم السجل" });
    await renderDialog();
    openFailuresTab();
    expect(screen.getByText("الكاشير القديم")).toBeInTheDocument();
    expect(screen.getByText("C-9")).toBeInTheDocument();
  });

  it("survives the reload that erases lastReport", async () => {
    recordFailure({ id: "checkout:X", kind: "checkout", message: "فشل دائم" });
    // Cold read, as after a reload — nothing in memory.
    __resetFailureLogCacheForTests();
    await renderDialog();
    openFailuresTab();
    expect(screen.getByText("فشل دائم")).toBeInTheDocument();
  });
});

describe("clearing is supervisor-gated", () => {
  it("is disabled for a cashier, and says why", async () => {
    recordFailure({ id: "a", message: "خطأ" });
    await renderDialog({ supervisor: false });
    openFailuresTab();
    const clear = screen.getByRole("button", { name: /مسح السجل/ });
    expect(clear).toBeDisabled();
    expect(clear).toHaveAttribute("title", "مسح السجل يتطلب صلاحية مشرف");
  });

  it("is a two-tap confirm for a supervisor, and actually empties the log", async () => {
    recordFailure({ id: "a", message: "خطأ" });
    await renderDialog({ supervisor: true });
    openFailuresTab();

    fireEvent.click(screen.getByRole("button", { name: /مسح السجل/ }));
    // Armed, not fired.
    expect(readFailures()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "تأكيد المسح" }));
    expect(readFailures()).toEqual([]);
    expect(screen.getByText("لا إخفاقات مسجّلة")).toBeInTheDocument();
  });

  it("can be backed out of", async () => {
    recordFailure({ id: "a", message: "خطأ" });
    await renderDialog({ supervisor: true });
    openFailuresTab();
    fireEvent.click(screen.getByRole("button", { name: /مسح السجل/ }));
    fireEvent.click(screen.getByRole("button", { name: "تراجع" }));
    expect(readFailures()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /مسح السجل/ })).toBeInTheDocument();
  });

  it("offers nothing to clear when the log is already empty", async () => {
    await renderDialog({ supervisor: true });
    openFailuresTab();
    expect(screen.getByRole("button", { name: /مسح السجل/ })).toBeDisabled();
  });
});
