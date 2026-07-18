/**
 * Cashier V2 — single-screen POS. RTL, touch-first, offline-first.
 * Layout: ≥1024px three columns (categories | products | cart),
 * 768–1023px two columns (categories as top chips), <768px single column
 * with a bottom cart sheet. Keyboard: F2 search, F4 pay, F9 hold, Esc close.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChefHat, LogIn, PauseCircle, ShoppingBasket, Store, Tag } from "lucide-react";
import { usePos } from "@/state/store";
import { listOrders } from "@/lib/api";
import { initPwa } from "@/lib/pwa";
import { runLegacyDrainOnce, getDrainStatus } from "@/lib/legacyDrain";
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
import { MyInvoicesDialog } from "@/components/dialogs/MyInvoicesDialog";
import { StocktakeDialog } from "@/components/dialogs/StocktakeDialog";
import { RequisitionsDialog } from "@/components/dialogs/RequisitionsDialog";
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
    channels,
    channelId,
    setChannel,
  } = usePos();

  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The grid windows against this element; it is the one that scrolls, and the
  // grid cannot reach it on its own. STATE, not a ref: React runs the child's
  // effects before this parent's ref callback, so a ref would still be null when
  // the virtualizer first reads it and nothing would re-trigger the read.
  const [gridScrollEl, setGridScrollEl] = useState<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [payOpen, setPayOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [myInvoicesOpen, setMyInvoicesOpen] = useState(false);
  const [stocktakeOpen, setStocktakeOpen] = useState(false);
  const [requisitionsOpen, setRequisitionsOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [holdBusy, setHoldBusy] = useState(false);
  const [voidBusy, setVoidBusy] = useState(false);
  const [lastHeld, setLastHeld] = useState<LocalOrder | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);

  // ── PWA (SW registration + install prompt) + legacy-queue drain ──────────
  useEffect(() => {
    initPwa();
  }, []);
  useEffect(() => {
    if (!user) return;
    void runLegacyDrainOnce().then((outcome) => {
      if (!outcome || outcome.attempted === 0) return;
      if (outcome.succeeded.length > 0) {
        pushToast("success", `تمت مزامنة ${outcome.succeeded.length} عملية من النسخة القديمة`);
      }
      setDrainOpen(true); // small report: what synced, what stayed
    });
  }, [user, pushToast]);

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
      // a per-unit (carton) barcode adds that unit; otherwise the base unit
      addItem(hit.item, hit.unitCode);
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

  // ── Sales channel strip (close/w25-sell-ui) ──────────────────────────────
  // The selector renders only when the owner actually has channels (the
  // implicit base «الأساسي» + ≥1 configured channel). An old server sends no
  // channels → nothing renders and the POS behaves exactly as before.
  const showChannelPicker = channels.length >= 1;
  // A persisted id whose channel was deleted server-side degrades to base.
  const activeChannelId = channels.some((c) => c.id === channelId) ? channelId : null;
  // «أسعار من قائمة: X» — shown when any served item carries a priceSource
  // (the server resolved a channel price list over the base price).
  const priceListName = useMemo(() => {
    for (const it of catalog?.items ?? []) if (it.priceSource) return it.priceSource;
    return null;
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
      <Header
        onOpenShiftDialog={() => setShiftOpen(true)}
        onOpenSyncReport={() => setSyncOpen(true)}
        onOpenMyInvoices={() => setMyInvoicesOpen(true)}
        onOpenStocktake={() => setStocktakeOpen(true)}
        onOpenRequisitions={() => setRequisitionsOpen(true)}
        onOpenDrainReport={() => setDrainOpen(true)}
      />

      <main className="flex min-h-0 flex-1 gap-3 p-3">
        {/* Category rail — first column in RTL, ≥1024px only */}
        <aside className="hidden w-44 shrink-0 lg:block" aria-label="التصنيفات">
          <CategoryRail categories={catalog?.categories ?? []} counts={categoryCounts} active={category} onSelect={setCategory} />
        </aside>

        {/* Products */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5" aria-label="الأصناف">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[12rem] flex-1">
              <SearchBox ref={searchRef} query={query} onQueryChange={setQuery} onScanSubmit={onScanSubmit} />
            </div>
            {showChannelPicker ? (
              <label className="flex shrink-0 items-center gap-1.5">
                <Store className="h-4 w-4 text-slate-400" aria-hidden />
                <span className="sr-only">قناة البيع</span>
                <select
                  value={activeChannelId ?? ""}
                  onChange={(e) => setChannel(e.target.value || null)}
                  aria-label="قناة البيع"
                  className="field min-h-11 w-auto max-w-[11rem] text-xs font-extrabold"
                >
                  <option value="">الأساسي</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {priceListName ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-[11px] font-extrabold text-teal-700">
                <Tag className="h-3.5 w-3.5" aria-hidden />
                أسعار من قائمة: <span className="rounded-md bg-white px-1.5">{priceListName}</span>
              </span>
            ) : null}
          </div>
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
            <div ref={setGridScrollEl} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
              <ProductGrid catalog={catalog} loading={catalogLoading} category={category} query={query} onAdd={addItem} scrollElement={gridScrollEl} />
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
      <MyInvoicesDialog open={myInvoicesOpen} onClose={() => setMyInvoicesOpen(false)} />
      <StocktakeDialog open={stocktakeOpen} onClose={() => setStocktakeOpen(false)} />
      <RequisitionsDialog open={requisitionsOpen} onClose={() => setRequisitionsOpen(false)} />

      {/* Legacy-queue drain report (offline sales queued by the OLD cashier) */}
      <Dialog open={drainOpen} onClose={() => setDrainOpen(false)} title="مزامنة النسخة القديمة" widthClass="max-w-md">
        {(() => {
          const st = getDrainStatus();
          if (!st.outcome) {
            return (
              <p className="py-4 text-center text-sm font-bold text-slate-500">
                {st.pending > 0
                  ? `${fmtInt(st.pending)} عملية من الكاشير القديم بانتظار المزامنة — تتم المحاولة عند توفر الاتصال`
                  : "لا عمليات معلّقة من الكاشير القديم"}
              </p>
            );
          }
          const { succeeded, failed } = st.outcome;
          return (
            <div className="space-y-3">
              <p className="text-sm font-extrabold text-slate-600">
                تمت مزامنة <span className="num">{fmtInt(succeeded.length)}</span> عملية من النسخة القديمة
                {failed.length > 0 ? (
                  <span className="text-amber-700"> — {fmtInt(failed.length)} لم تُزامَن وبقيت محفوظة</span>
                ) : null}
              </p>
              {succeeded.length > 0 ? (
                <ul className="space-y-1">
                  {succeeded.map((s) => (
                    <li key={s.clientOrderId} className="flex items-center justify-between rounded-xl border border-teal-100 bg-teal-50/50 px-3 py-2 text-xs font-bold text-slate-600">
                      <span className="num" dir="ltr">{s.clientOrderId}</span>
                      <span className="text-teal-600">نجحت{s.orderId ? ` — فاتورة ${s.orderId}` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {failed.length > 0 ? (
                <ul className="space-y-1">
                  {failed.map((f, i) => (
                    <li key={`${f.clientOrderId ?? "invalid"}-${i}`} className="flex items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50/50 px-3 py-2 text-xs font-bold text-slate-600">
                      <span className="num" dir="ltr">{f.clientOrderId ?? "؟"}</span>
                      <span className="text-red-600">{f.error}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })()}
      </Dialog>

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
