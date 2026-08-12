import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, CornerDownLeft } from "lucide-react";
import { NAV_ITEMS, canAccessNavItem, navGroupOf } from "@/app/navigation/manifest";
import { usePermissions } from "@/app/providers";
import { useT } from "@/i18n";
import { getIcon } from "./icons";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

// ⌘K command palette — searches the permitted nav items and navigates on Enter.
// Full keyboard support (↑/↓ move, Enter opens, Esc closes).
export function CommandPalette() {
  const t = useT();
  const { paletteOpen, closePalette } = useShell();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const permitted = useMemo(() => NAV_ITEMS.filter((i) => canAccessNavItem(i, can)), [can]);
  // Resolve each label through t() up front, so the search matches the VISIBLE
  // (translated) text — not the raw `nav.items.*` key the manifest now carries.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const enriched = permitted.map((item) => ({ item, label: t(item.label) }));
    const list = q
      ? enriched.filter(({ item, label }) => label.toLowerCase().includes(q) || item.path.includes(q))
      : enriched;
    return list.slice(0, 40);
  }, [permitted, query, t]);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setActive(0);
      // focus after paint
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [paletteOpen]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!paletteOpen) return null;

  function go(path: string) {
    closePalette();
    navigate(path);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[active];
      if (result) go(result.item.path);
    }
  }

  return (
    <div
      className="no-print fixed inset-0 z-modal grid place-items-start justify-center bg-slate-950/40 p-4 pt-[12vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.commandPalette.ariaLabel")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lift" onKeyDown={onKeyDown}>
        <label className="flex items-center gap-2 border-b border-slate-100 px-4">
          <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-h-12 w-full bg-transparent text-sm font-semibold text-slate-700 outline-none placeholder:font-normal placeholder:text-slate-400"
            placeholder={t("shell.commandPalette.inputPlaceholder")}
            aria-label={t("shell.commandPalette.inputAriaLabel")}
          />
          <kbd className="hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-400 sm:inline">Esc</kbd>
        </label>

        <div className="max-h-[52vh] overflow-y-auto p-2 scrollbar-thin">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm font-medium text-slate-400">{t("shell.commandPalette.noResults")}</div>
          ) : (
            results.map(({ item, label }, i) => {
              const Icon = getIcon(item.icon);
              const group = navGroupOf(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item.path)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start text-sm font-bold transition",
                    i === active ? "bg-teal-50 text-teal-800" : "text-slate-700 hover:bg-slate-50",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="flex-1 truncate">{label}</span>
                  {group && <span className="text-[10px] font-bold text-slate-400">{t(group.label)}</span>}
                  {i === active && <CornerDownLeft className="h-3.5 w-3.5 text-teal-500" aria-hidden="true" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
