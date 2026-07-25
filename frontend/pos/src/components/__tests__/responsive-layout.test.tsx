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
// Header and CartPanel resolve strings via useT(), which throws without an
// ancestor I18nProvider (see i18n/I18nProvider.tsx).
import { I18nProvider } from "@/i18n/I18nProvider";

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
    render(
      <I18nProvider>
        <Header {...props} />
      </I18nProvider>,
    );

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

  it("removes the obsolete cashier link and keeps status controls under المزيد", () => {
    currentCtx = makeCtx();
    render(
      <I18nProvider>
        <Header {...headerProps()} />
      </I18nProvider>,
    );

    expect(screen.queryByText("الكاشير القديم")).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "المزيد" });
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: /متصل/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /متصل/ })).not.toBeInTheDocument();
  });

  // PORTAL ISOLATION. The «العودة للنظام» link is a hard href into the ERP
  // bundle. A cashier is now redirected straight back out of /app and their
  // token is refused on back-office API paths, so for them the link is a dead
  // end — it must not render at all. A supervisor works in both apps, so it
  // must still be there: this asserts BOTH directions, because a fix that
  // simply deleted the link would look "secure" while breaking managers.
  it("hides the back-to-back-office link for a cashier but keeps it for a supervisor", () => {
    const linkName = "العودة للنظام الرئيسي";

    currentCtx = makeCtx(); // default fixture user is role: "cashier"
    render(
      <I18nProvider>
        <Header {...headerProps()} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.queryByRole("link", { name: linkName })).not.toBeInTheDocument();

    cleanup();

    currentCtx = makeCtx({ overrides: { user: { username: "mgr1", role: "manager" } } });
    render(
      <I18nProvider>
        <Header {...headerProps()} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getByRole("link", { name: linkName })).toHaveAttribute("href", "/app/");
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
    render(
      <I18nProvider>
        <CartPanel {...props} />
      </I18nProvider>,
    );

    const name = screen.getByText(longName);
    expect(name).toHaveClass("break-words");
    expect(name).toHaveClass("line-clamp-2");
    const detailsButton = screen.getByRole("button", { name: `تفاصيل ${longName}` });
    expect(detailsButton).toHaveClass("min-w-0");
    expect(screen.getByRole("button", { name: `حذف ${longName}` })).toHaveClass("shrink-0");
  });
});
