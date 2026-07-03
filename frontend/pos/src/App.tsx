/**
 * Cashier V2 — single-screen POS. RTL, touch-first, offline-first.
 * Layout: ≥1024px three columns (categories | products | cart),
 * 768–1023px two columns (categories as top chips), <768px single column
 * with a bottom cart sheet. Keyboard: F2 search, F4 pay, F9 hold, Esc close.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChefHat, LogIn, PauseCircle, ShoppingBasket } from "lucide-react";
import { usePos } from "@/state/store";
import { listOrders } from "@/lib/api";
import { fmt2, fmtInt } from "@/lib/format";
import { buildKitchenTicketHtml, printHtml } from "@/lib/receipt";
import { resolveScan } from "@/components/ProductGrid";
import type { LocalOrder } from "@/lib/types";
import { Header } from "@/components/Header";
import { CategoryRail } from "@/components/CategoryRail";
import { ProductGrid, SearchBox } from "@/components/ProductGrid";
import { CartPanel } from "@/components/CartPanel";
import { Toasts } from "@/components/Toasts";
import { Dialog } from "@/components/Dialog";
import { PaymentDialog } from "@/components/dialogs/PaymentDialog";
import { HeldOrdersDialog } from "@/components/dialogs/HeldOrdersDialog";
import { ShiftDialog } from "@/components/dialogs/ShiftDialog";
import { VoidDialog } from "@/components/dialogs/VoidDialog";
import { DiscountDialog } from "@/components/dialogs/DiscountDialog";
import { SyncReportDialog } from "@/components/dialogs/SyncReportDialog";
import { Button, ErrorBanner, Money } from "@/components/ui";

function LoginRequired() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-ink text-saffron-500 shadow-lift">
        <ChefHat className="h-10 w-10" aria-hidden />
      </div>
      <h1 className="text-xl font-extrabold text-ink">المذاق المغربي — كاشير V2</h1>
      <p className="max-w-sm text-sm font-bold text-slate-500">
        لا توجد جلسة دخول نشطة على هذا الجهاز. سجّل الدخول من النظام الرئيسي ثم عد إلى هذه الصفحة.
      </p>
      <a
        href="/"
        className="btn-press inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-6 text-sm font-bold text-white shadow-sm hover:bg-teal-700"
      >
        <LogIn className="h-4 w-4" aria-hidden />
        سجّل الدخول من النظام الرئيسي
      </a>
    </main>
  );
}

export default function App() {
  const {
    user,
    catalog,
    catalogLoading,
    catalogError,
    refetchCatalog,
    cart,
    totals,
    addItem,
    startNewOrder,
    engine,
    engineStatus,
    pushToast,
  } = usePos();

  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [holdBusy, setHoldBusy] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [lastHeld, setLastHeld] = useState<LocalOrder | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);

  // ── Held count (badge) ───────────────────────────────────────────────────
  const refreshHeldCount = useCallback(async () => {
    try {
      const local = await engine.localHeldOrders();
      const ids = new Set(local.map((d) => d.id));
      if (engineStatus.online) {
        try {
          const res = await listOrders({ status: "held" });
          for (const o of res.data) ids.add(o.id);
        } catch {
          /* offline count only */
        }
      }
      setHeldCount(ids.size);
    } catch {
      setHeldCount(0);
    }
  }, [engine, engineStatus.online]);

  useEffect(() => {
    void refreshHeldCount();
  }, [refreshHeldCount]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "F4") {
        e.preventDefault();
        if (cart.lines.length > 0) setPayOpen(true);
      } else if (e.key === "F9") {
        e.preventDefault();
        if (cart.lines.length > 0 && !holdBusy) void holdCurrent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.lines.length, holdBusy]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const onScanSubmit = useCallback(() => {
    if (!catalog) return;
    const hit = resolveScan(catalog.items, query);
    if (hit) {
      addItem(hit);
      setQuery("");
    } else if (query.trim()) {
      pushToast("error", `لا صنف يطابق «${query.trim()}»`);
    }
  }, [catalog, query, addItem, pushToast]);

  async function holdCurrent() {
    if (!cart.lines.length) return;
    setHoldBusy(true);
    try {
      const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
      await engine.holdOrder(snapshot);
      setLastHeld(snapshot);
      startNewOrder();
      pushToast("success", "عُلّق الطلب — يمكنك استعادته من «الطلبات المعلقة»");
      void refreshHeldCount();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setHoldBusy(false);
    }
  }

  async function voidCurrent(reason: string) {
    setVoidBusy(true);
    try {
      const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
      await engine.voidOrder(snapshot, reason);
      startNewOrder();
      setVoidOpen(false);
      pushToast("success", "أُلغي الطلب");
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setVoidBusy(false);
    }
  }

  // Voiding an already-synced order while OFFLINE is forbidden (the server
  // copy would survive and complete elsewhere) — local unsynced voids are fine.
  const voidDisabledReason =
    !engineStatus.online && cart.serverVersion != null ? "إلغاء طلب مزامَن غير متاح بلا اتصال" : null;

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of catalog?.items ?? []) {
      if (!it.active) continue;
      counts[it.category] = (counts[it.category] ?? 0) + 1;
    }
    return counts;
  }, [catalog]);

  if (!user) return <LoginRequired />;

  const itemCount = cart.lines.reduce((s, l) => s + l.qty, 0);

  const cartPanel = (
    <CartPanel
      heldCount={heldCount}
      onPay={() => setPayOpen(true)}
      onHold={() => void holdCurrent()}
      onOpenHeld={() => setHeldOpen(true)}
      onVoid={() => setVoidOpen(true)}
      onOpenDiscount={() => setDiscountOpen(true)}
      holdBusy={holdBusy}
      voidDisabledReason={voidDisabledReason}
    />
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Toasts />
      <Header onOpenShiftDialog={() => setShiftOpen(true)} onOpenSyncReport={() => setSyncOpen(true)} />

      <main className="flex min-h-0 flex-1 gap-3 p-3">
        {/* Category rail — first column in RTL, ≥1024px only */}
        <aside className="hidden w-44 shrink-0 lg:block" aria-label="التصنيفات">
          <CategoryRail categories={catalog?.categories ?? []} counts={categoryCounts} active={category} onSelect={setCategory} />
        </aside>

        {/* Products */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5" aria-label="الأصناف">
          <SearchBox ref={searchRef} query={query} onQueryChange={setQuery} onScanSubmit={onScanSubmit} />
          {/* Horizontal categories under 1024px */}
          <div className="lg:hidden">
            <CategoryRail
              categories={catalog?.categories ?? []}
              counts={categoryCounts}
              active={category}
              onSelect={setCategory}
              horizontal
            />
          </div>
          {catalogError && !catalog ? (
            <ErrorBanner message={catalogError} onRetry={refetchCatalog} />
          ) : (
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
              <ProductGrid catalog={catalog} loading={catalogLoading} category={category} query={query} onAdd={addItem} />
            </div>
          )}
        </section>

        {/* Cart — side panel from 768px up */}
        <aside className="hidden w-[24rem] shrink-0 md:block xl:w-[26rem]" aria-label="السلة">
          {cartPanel}
        </aside>
      </main>

      {/* Mobile bottom cart bar + sheet (<768px) */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-2.5 shadow-lift backdrop-blur md:hidden">
        <Button variant="primary" size="lg" className="w-full" onClick={() => setCartSheetOpen(true)}>
          <ShoppingBasket className="h-5 w-5" aria-hidden />
          السلة (<Money value={fmtInt(itemCount)} />) — <Money value={fmt2(totals.total)} /> ر.س
        </Button>
      </div>
      {cartSheetOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink/45 md:hidden" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setCartSheetOpen(false)}>
          <div className="sheet-in mt-14 flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-2xl bg-canvas p-2.5">
            <div className="mb-1 flex justify-center">
              <button
                type="button"
                onClick={() => setCartSheetOpen(false)}
                aria-label="إغلاق السلة"
                className="h-1.5 w-12 rounded-full bg-slate-300"
              />
            </div>
            <div className="min-h-0 flex-1">{cartPanel}</div>
          </div>
        </div>
      ) : null}

      {/* Dialogs */}
      <PaymentDialog
        open={payOpen}
        onClose={() => {
          setPayOpen(false);
          setCartSheetOpen(false);
        }}
      />
      <HeldOrdersDialog open={heldOpen} onClose={() => setHeldOpen(false)} onCountChange={setHeldCount} />
      <ShiftDialog open={shiftOpen} onClose={() => setShiftOpen(false)} />
      <VoidDialog open={voidOpen} onClose={() => setVoidOpen(false)} onConfirm={(r) => void voidCurrent(r)} busy={voidBusy} />
      <DiscountDialog open={discountOpen} onClose={() => setDiscountOpen(false)} />
      <SyncReportDialog open={syncOpen} onClose={() => setSyncOpen(false)} />

      {/* Post-hold kitchen ticket offer */}
      <Dialog open={!!lastHeld} onClose={() => setLastHeld(null)} title="تم تعليق الطلب" widthClass="max-w-sm">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <PauseCircle className="h-12 w-12 text-saffron-500" aria-hidden />
          <p className="text-sm font-bold text-slate-500">هل تريد طباعة تذكرة للمطبخ الآن؟</p>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setLastHeld(null)}>
              لاحقًا
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (lastHeld && !printHtml(buildKitchenTicketHtml(lastHeld))) {
                  pushToast("error", "المتصفح منع نافذة الطباعة");
                }
                setLastHeld(null);
              }}
            >
              <ChefHat className="h-4 w-4" aria-hidden />
              طباعة للمطبخ
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
