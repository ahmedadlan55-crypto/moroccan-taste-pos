import { Search } from "lucide-react";
import { useShell } from "./shell-context";

// A search affordance in the topbar that opens the command palette. It is a
// button styled as an input (the real search UX lives in the palette, ⌘K).
export function GlobalSearch() {
  const { openPalette } = useShell();
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="بحث والانتقال السريع (Ctrl+K)"
      className="field flex w-full max-w-sm items-center gap-2 text-slate-400 hover:border-slate-300"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-right text-sm font-normal">بحث والانتقال السريع…</span>
      <kbd className="hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-400 sm:inline">Ctrl K</kbd>
    </button>
  );
}
