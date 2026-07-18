import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PosContextValue } from "@/state/store";
import { makeCtx, makeLine, makeOrder } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

const pwaStatus = { canInstall: false, updateReady: false };
vi.mock("@/lib/pwa", () => ({
  getPwaStatus: () => pwaStatus,
  subscribePwa: () => () => {},
  promptInstall: vi.fn(),
  applyUpdate: vi.fn(),
}));

const drainStatus = { state: "idle", pending: 0, outcome: null };
vi.mock("@/lib/legacyDrain", () => ({
  getDrainStatus: () => drainStatus,
  subscribeDrain: () => () => {},
}));

import { Header } from "../Header";
import { CartPanel, type CartPanelProps } from "../CartPanel";
import { productColumnsForWidth } from "../ProductGrid";

afterEach(() => cleanup());

function headerProps() {
  return {
    onOpenShiftDialog: vi.fn(),
    onOpenSyncReport: vi.fn(),
    onOpenMyInvoices: vi.fn(),
    onOpenStocktake: vi.fn(),
    onOpenRequisitions: vi.fn(),
    onOpenDrainReport: vi.fn(),
  };
}

describe("responsive cashier header", () => {
  it("keeps the cashier identity and every primary action label in the DOM on mobile", () => {
    currentCtx = makeCtx();
    const props = headerProps();
    render(<Header {...props} />);

    expect(screen.getByTestId("cashier-identity")).toHaveTextContent("cashier");
    const quick = screen.getByTestId("pos-quick-actions");
    expect(quick).toHaveClass("grid-cols-2");
    for (const label of ["فواتيري", "جرد المخزون", "طلب النواقص", "المزيد"]) {
      const text = screen.getByText(label);
      expect(text).toBeVisible();
      expect(text.className).not.toContain("hidden");
    }

    fireEvent.click(screen.getByRole("button", { name: "جرد المخزون" }));
    fireEvent.click(screen.getByRole("button", { name: "طلب النواقص" }));
    expect(props.onOpenStocktake).toHaveBeenCalledTimes(1);
    expect(props.onOpenRequisitions).toHaveBeenCalledTimes(1);
  });

  it("removes the obsolete cashier link and keeps system/status controls under المزيد", () => {
    currentCtx = makeCtx();
    render(<Header {...headerProps()} />);

    expect(screen.queryByText("الكاشير القديم")).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "المزيد" });
    fireEvent.click(more);
    expect(screen.getByRole("link", { name: "العودة للنظام الرئيسي" })).toHaveAttribute("href", "/app/");
    expect(screen.getByRole("button", { name: /متصل/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("link", { name: "العودة للنظام الرئيسي" })).not.toBeInTheDocument();
  });
});

describe("container-driven product grid", () => {
  it("uses the real product surface width instead of the full viewport", () => {
    expect(productColumnsForWidth(390)).toBe(2);
    expect(productColumnsForWidth(599)).toBe(2);
    expect(productColumnsForWidth(600)).toBe(3);
    expect(productColumnsForWidth(899)).toBe(3);
    expect(productColumnsForWidth(900)).toBe(4);
  });
});

describe("cart line responsive structure", () => {
  it("gives long Arabic names a min-width escape hatch and a separate controls row", () => {
    const longName = "وجبة عائلية مغربية كبيرة جدًا مع إضافات واختيارات متعددة وملاحظات طويلة";
    currentCtx = makeCtx({ cart: makeOrder({ lines: [makeLine({ name: longName })] }) });
    const props: CartPanelProps = {
      heldCount: 0,
      onPay: vi.fn(),
      onHold: vi.fn(),
      onOpenHeld: vi.fn(),
      onVoid: vi.fn(),
      onOpenDiscount: vi.fn(),
      holdBusy: false,
      voidDisabledReason: null,
    };
    render(<CartPanel {...props} />);

    const name = screen.getByText(longName);
    expect(name).toHaveClass("break-words");
    expect(name).toHaveClass("line-clamp-2");
    const detailsButton = screen.getByRole("button", { name: `تفاصيل ${longName}` });
    expect(detailsButton).toHaveClass("min-w-0");
    expect(screen.getByRole("button", { name: `حذف ${longName}` })).toHaveClass("shrink-0");
  });
});
