import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/shared/lib";
import { useOptionalLang } from "@/i18n";

export interface DropdownMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}

export interface DropdownMenuProps {
  /** The trigger. It receives props to spread onto a clickable element. */
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: "start" | "end";
  className?: string;
  "aria-label"?: string;
}

/**
 * Accessible dropdown menu (role=menu/menuitem). Opens on click, closes on
 * outside click / Escape / selection, arrow-key roving between items, and
 * restores focus to the trigger on close.
 */
export function DropdownMenu({
  trigger,
  items,
  align = "end",
  className,
  "aria-label": ariaLabel,
}: DropdownMenuProps) {
  const lang = useOptionalLang() ?? "ar";
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const enabledIndexes = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  function moveActive(dir: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const pos = enabledIndexes.indexOf(active);
    const next = enabledIndexes[(pos + dir + enabledIndexes.length) % enabledIndexes.length];
    setActive(next);
  }

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          setActive(enabledIndexes[0] ?? 0);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setActive(enabledIndexes[0] ?? 0);
            setOpen(true);
          }
        }}
        className="inline-flex focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        {trigger}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={ariaLabel}
          dir={lang === "ar" ? "rtl" : "ltr"}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              moveActive(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              moveActive(-1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
          className={cn(
            "absolute z-popover mt-1 min-w-44 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl ring-1 ring-black/5",
            align === "end" ? "end-0" : "start-0",
          )}
        >
          {items.map((it, i) => (
            <button
              key={it.key}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={i === active ? 0 : -1}
              disabled={it.disabled}
              onClick={() => {
                it.onSelect();
                close();
              }}
              onMouseEnter={() => !it.disabled && setActive(i)}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-semibold transition focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                it.tone === "danger"
                  ? "text-rose-600 hover:bg-rose-50"
                  : "text-slate-700 hover:bg-slate-50",
                i === active && !it.disabled && (it.tone === "danger" ? "bg-rose-50" : "bg-slate-50"),
              )}
            >
              {it.icon && <span className="shrink-0 text-slate-400">{it.icon}</span>}
              <span className="min-w-0 flex-1 break-words">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
