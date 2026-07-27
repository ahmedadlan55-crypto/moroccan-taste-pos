/**
 * CustomerPicker — the searchable customer selector for POS V2 (Order-to-Cash).
 * Opens showing the FIRST PAGE instantly (no typing needed), searches the server
 * (/api/order-to-cash/customers/search) with a 250ms debounce, supports keyboard
 * navigation + ARIA, and surfaces a loading / empty / error+retry state (never a
 * silent empty list). No native <select>. Selecting a row returns the REAL
 * customerId (+ name/phone + credit summary) to the caller.
 *
 * W2-B — CREDIT EXPOSURE AT ATTACH TIME. The credit ceiling used to reveal
 * itself only at the tender, as a server 422 CREDIT_LIMIT_EXCEEDED, with the
 * customer already standing at the counter and the whole cart built. The linked
 * customer now carries the live limit / used / available strip the moment they
 * are attached (GET /api/order-to-cash/customers/:id/exposure), and CartPanel
 * warns BEFORE the payment dialog opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, History, Loader2, Search, UserPlus, Wallet, X } from "lucide-react";
import {
  getCustomerExposure,
  getCustomerSummary,
  isFeatureUnavailable,
  searchCustomers,
  type CustomerExposure,
  type PosCustomerHit,
} from "@/lib/api";
import { fmt2 } from "@/lib/format";
import { useT } from "@/i18n/I18nProvider";
import type { TFunction } from "@/i18n/types";
import { CustomerAddDialog } from "./dialogs/CustomerAddDialog";
import { CustomerHistoryDialog } from "./dialogs/CustomerHistoryDialog";
import { cn } from "./ui";

// ── Credit exposure ─────────────────────────────────────────────────────────
// Deliberately NOT react-query: CartPanel consumes the same reading to warn
// before the tender, and CartPanel is mounted with no QueryClientProvider in
// its spec harness (parity-cart-panel.test.tsx). A tiny TTL cache keeps the two
// consumers to ONE request per customer per window.

export type CreditExposureState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: CustomerExposure }
  /** Flag off (404) or outside the cashier portal's allow-list (403). */
  | { status: "unavailable" }
  | { status: "error"; message: string };

const EXPOSURE_TTL_MS = 30_000;
const exposureCache = new Map<string, { at: number; promise: Promise<CustomerExposure> }>();

/** Test hook — drops the TTL cache. */
export function _resetCreditExposureCache(): void {
  exposureCache.clear();
}

/**
 * Live credit exposure for `customerId`. Every failure is NON-BLOCKING: an
 * unreachable endpoint (flag off / portal-scoped away) resolves to
 * `unavailable` and the UI simply omits the strip — selling is never gated on
 * an advisory read. The SERVER remains the authority (CreditLimitService).
 */
export function useCreditExposure(customerId: string | null | undefined): CreditExposureState {
  const [state, setState] = useState<CreditExposureState>({ status: "idle" });
  useEffect(() => {
    if (!customerId) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    const hit = exposureCache.get(customerId);
    const fresh = hit && Date.now() - hit.at < EXPOSURE_TTL_MS ? hit.promise : null;
    const promise = fresh ?? getCustomerExposure(customerId);
    if (!fresh) exposureCache.set(customerId, { at: Date.now(), promise });
    promise.then(
      (data) => {
        if (alive) setState({ status: "ready", data });
      },
      (e: unknown) => {
        exposureCache.delete(customerId); // a failure must not stick for 30s
        if (!alive) return;
        setState(
          isFeatureUnavailable(e)
            ? { status: "unavailable" }
            : { status: "error", message: (e as Error)?.message || "" },
        );
      },
    );
    return () => {
      alive = false;
    };
  }, [customerId]);
  return state;
}

/**
 * Would putting `creditAmount` on this customer's account break their limit?
 * Mirrors CreditLimitService.assess: over when exposure + amount exceeds the
 * limit by more than a halala, and a zero limit means "no credit at all".
 */
export function exceedsCreditLimit(e: CustomerExposure, creditAmount: number): boolean {
  const amount = Number(creditAmount) || 0;
  if (amount <= 0) return false;
  if (!(e.creditLimit > 0)) return true;
  return e.exposure + amount - e.creditLimit > 0.01;
}

export interface CustomerPickerProps {
  value: { id: string; name: string | null; phone: string | null } | null;
  onChange: (c: { id: string; name: string | null; phone: string | null } | null) => void;
}

/**
 * The limit / used / available strip under an attached customer.
 *
 * Rendered ONLY when the reading is live AND the customer actually has a credit
 * relationship (a limit, or an outstanding balance). A cash-only walk-in gets
 * nothing — the strip must not turn every attach into a credit conversation.
 */
export function CreditExposureStrip({ customerId }: { customerId: string }) {
  const t = useT();
  const state = useCreditExposure(customerId);

  if (state.status === "error") {
    return (
      <p className="mt-1.5 text-[10px] font-bold text-slate-400">{t("customerPicker.credit.loadError")}</p>
    );
  }
  if (state.status !== "ready") return null;
  const e = state.data;
  if (!(e.creditLimit > 0) && !(e.exposure > 0)) return null;

  const over = e.available < 0;
  return (
    <dl
      className={cn(
        "mt-1.5 grid grid-cols-3 gap-1 rounded-xl border px-2.5 py-1.5 text-center",
        over ? "border-red-200 bg-red-50" : "border-slate-200 bg-white",
      )}
      aria-label={t("customerPicker.credit.aria")}
    >
      <div>
        <dt className="text-[10px] font-bold text-slate-400">{t("customerPicker.credit.limit")}</dt>
        <dd className="num text-[11px] font-extrabold text-slate-600">{fmt2(e.creditLimit)}</dd>
      </div>
      <div>
        <dt className="text-[10px] font-bold text-slate-400">{t("customerPicker.credit.used")}</dt>
        <dd className="num text-[11px] font-extrabold text-slate-600">{fmt2(e.exposure)}</dd>
      </div>
      <div>
        <dt className="text-[10px] font-bold text-slate-400">{t("customerPicker.credit.available")}</dt>
        <dd className={cn("num text-[11px] font-extrabold", over ? "text-red-700" : "text-teal-700")}>
          {fmt2(e.available)}
        </dd>
      </div>
    </dl>
  );
}

function sublabel(c: PosCustomerHit, t: TFunction): string {
  const bits: string[] = [];
  if (c.phone) bits.push(c.phone);
  const bal = c.derived?.arBalance ?? c.balance;
  if (Number(c.creditLimit) > 0) {
    bits.push(t("customerPicker.available", { amount: fmt2(Number(c.creditLimit) - Number(bal || 0)) }));
  }
  return bits.join(" · ");
}

export function CustomerPicker({ value, onChange }: CustomerPickerProps) {
  const t = useT();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = useQuery({
    queryKey: ["o2c-customer-search", debounced],
    queryFn: () => searchCustomers(debounced, 1),
    enabled: !value, // only search while picking
    staleTime: 15_000,
  });

  // Always-visible totals strip for the LINKED customer (legacy
  // _posCustomerLoadSummary :1347 — «<total> ر.س» next to the name).
  const summaryQuery = useQuery({
    queryKey: ["cust-summary", value?.id],
    queryFn: () => getCustomerSummary(value!.id),
    enabled: !!value?.id,
    staleTime: 30_000,
  });

  // Doubles as the reachability probe for /api/order-to-cash from this till:
  // when the exposure read comes back `unavailable` (flag off → 404, or outside
  // middleware/posPortalScope's allow-list → 403) the سند قبض affordance — which
  // lives on the same namespace — is hidden instead of offered and then failing.
  // The TTL cache in useCreditExposure keeps this to ONE request per customer.
  const exposureState = useCreditExposure(value?.id ?? null);

  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  useEffect(() => { setActive(0); }, [debounced]);

  if (value) {
    return (
      <>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-extrabold text-teal-800">{value.name || t("customerPicker.fallbackName")}</span>
            {value.phone ? <span dir="ltr" className="truncate text-[11px] font-bold text-teal-600 num">{value.phone}</span> : null}
            {/* `kpi` read defensively: /summary is a live endpoint and this
                chip must never be the thing that white-screens the cart if a
                deployment ships a thinner body. */}
            {summaryQuery.data?.kpi ? (
              <span className="flex items-center gap-1 text-[11px] font-extrabold text-teal-700">
                <Coins className="h-3 w-3" aria-hidden />
                <span className="num">{fmt2(summaryQuery.data.kpi.totalSpent)}</span> {t("customerPicker.currency")}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {exposureState.status !== "unavailable" ? (
              <button
                type="button"
                onClick={() => { setCollectOpen(true); setHistOpen(true); }}
                className="grid min-h-11 min-w-11 place-items-center rounded-lg text-teal-500 transition hover:bg-white hover:text-teal-700"
                aria-label={t("customerPicker.selected.collectAria")}
                title={t("customerPicker.selected.collectAria")}
              >
                <Wallet className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => { setCollectOpen(false); setHistOpen(true); }}
              className="grid min-h-11 min-w-11 place-items-center rounded-lg text-teal-500 transition hover:bg-white hover:text-teal-700"
              aria-label={t("customerPicker.selected.historyAria")}
              title={t("customerPicker.selected.historyAria")}
            >
              <History className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="grid min-h-11 min-w-11 place-items-center rounded-lg text-teal-500 transition hover:bg-white hover:text-rose-600"
              aria-label={t("customerPicker.selected.clearAria")}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </span>
        </div>
        <CreditExposureStrip customerId={value.id} />
        {histOpen ? (
          <CustomerHistoryDialog
            open
            onClose={() => setHistOpen(false)}
            customer={value}
            allowCollect={exposureState.status !== "unavailable"}
            collectInitiallyOpen={collectOpen}
          />
        ) : null}
      </>
    );
  }

  function pick(c: PosCustomerHit | undefined) {
    if (!c) return;
    onChange({ id: c.id, name: c.name, phone: c.phone ?? null });
    setQ("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[active]); }
  }

  return (
    <div>
      <label className="relative block">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("customerPicker.search.placeholder")}
          className="field w-full ps-9"
          role="combobox"
          aria-expanded="true"
          aria-controls="o2c-cust-list"
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus
        />
      </label>
      <div id="o2c-cust-list" role="listbox" className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white">
        {query.isError ? (
          <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
            <span className="text-xs font-bold text-slate-500">{t("customerPicker.search.loadError")}</span>
            <button type="button" onClick={() => query.refetch()} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-700 hover:bg-slate-200">
              {t("customerPicker.search.retry")}
            </button>
          </div>
        ) : query.isLoading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs font-bold text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("customerPicker.search.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs font-bold text-slate-400">{t("customerPicker.search.empty")}</div>
        ) : (
          rows.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-start transition",
                i === active ? "bg-teal-50" : "hover:bg-slate-50",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-bold text-slate-700">{c.name}</span>
                {sublabel(c, t) ? <span dir="ltr" className="truncate text-[11px] font-bold text-slate-400 num">{sublabel(c, t)}</span> : null}
              </span>
            </button>
          ))
        )}
      </div>
      {/* «عميل جديد» (legacy posOpenCustomerAddModal :1736) — prefilled from the
          query: digits → phone, otherwise name. On create the customer is
          auto-attached through the same onChange the row-pick uses. */}
      <button
        type="button"
        onClick={() => setAddOpen(true)}
        className="btn-press mt-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-teal-300 bg-teal-50/50 text-xs font-extrabold text-teal-700 transition hover:bg-teal-50"
      >
        <UserPlus className="h-4 w-4" aria-hidden />
        {t("customerPicker.search.newCustomer")}
      </button>
      {addOpen ? (
        <CustomerAddDialog
          open
          onClose={() => setAddOpen(false)}
          prefill={/^[\d+\s-]{3,}$/.test(q.trim()) ? { phone: q.trim() } : q.trim() ? { name: q.trim() } : undefined}
          onCreated={(c) => {
            setAddOpen(false);
            onChange({ id: c.id, name: c.name, phone: c.phone || null });
          }}
          onRecallExisting={(phone) => {
            // Duplicate phone → back to the search, prefilled (legacy :1883).
            setAddOpen(false);
            setQ(phone);
            inputRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
