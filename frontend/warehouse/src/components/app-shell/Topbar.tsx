import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu, RefreshCw, ScanLine } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flatNav } from "@/app/navigation";
import { WarehouseScopeSelect } from "@/components/warehouse-scope/WarehouseScopeSelect";
import { Button } from "@/components/ui/button";
import { lookupBarcode } from "@/lib/hooks/useItems";

// Phase W4 — global barcode search: scan/type any code anywhere in the app →
// jumps straight to the matching item's detail drawer.
function BarcodeSearch({ compact }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "miss">("idle");

  async function go() {
    const c = code.trim();
    if (!c) return;
    setState("pending");
    try {
      const hit = await lookupBarcode(c);
      if (hit) {
        setCode(""); setState("idle");
        navigate(`/items?view=${encodeURIComponent(hit.itemId)}`);
      } else {
        setState("miss");
      }
    } catch { setState("miss"); }
  }

  return (
    <div className={compact ? "w-full" : "w-56"}>
      <label className="relative block">
        <ScanLine className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={`field w-full pr-9 font-mono text-xs ${state === "miss" ? "border-rose-300" : ""}`}
          dir="ltr"
          placeholder="مسح باركود…"
          aria-label="بحث بالباركود"
          value={code}
          onChange={(e) => { setCode(e.target.value); if (state === "miss") setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
        />
      </label>
      {state === "miss" && <span className="mt-0.5 block text-[10px] font-bold text-rose-600">لا يوجد صنف بهذا الباركود</span>}
    </div>
  );
}

export function Topbar() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <header className="no-print sticky top-0 z-20 border-b border-slate-200/80 bg-canvas/90 px-4 py-3 backdrop-blur-xl sm:px-6 lg:mr-72 xl:px-8">
      <div className="mx-auto max-w-[1680px]">
        <div className="flex items-center gap-3">
          {/* Mobile/tablet: menu + route picker */}
          <div className="flex min-w-0 items-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-navy text-white">
              <Menu className="h-5 w-5" />
            </span>
            <select
              className="field max-w-40"
              aria-label="اختيار الشاشة"
              onChange={(e) => navigate(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>
                انتقال…
              </option>
              {flatNav.map((item) => (
                <option key={item.id} value={item.path}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          {/* Desktop: scope inline */}
          <div className="hidden lg:block">
            <WarehouseScopeSelect />
          </div>

          <div className="mr-auto flex items-center gap-2">
            <div className="hidden md:block"><BarcodeSearch /></div>
            <Button variant="ghost" size="icon" aria-label="تحديث" onClick={() => qc.invalidateQueries()}>
              <RefreshCw className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Mobile/tablet: a dedicated full-width row so the CURRENT warehouse
            scope name is always clearly visible (and changeable) on phones. */}
        <div className="mt-2.5 flex flex-col gap-2 lg:hidden">
          <WarehouseScopeSelect fullWidth />
          <div className="md:hidden"><BarcodeSearch compact /></div>
        </div>
      </div>
    </header>
  );
}
