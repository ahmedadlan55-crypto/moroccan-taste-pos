// Sales Analytics Hub — the report picker.
//
// Sixteen sections do not belong in a tab strip: at any width below a desktop
// monitor the strip scrolls horizontally, so the section you want is usually
// off-screen and the current one has no context around it. Every mature
// analytics product solves this the same way — ONE control that names the
// report you are reading and opens a grouped menu of everything else. That is
// what this is.
//
// a11y: button[aria-haspopup=listbox] + role=listbox with role=group sections.
// Options are real buttons that take DOM focus (the house pattern, see
// shared/ui/dropdown-menu.tsx) so arrow keys, Home/End, Enter/Space, Escape and
// outside-click all behave without an aria-activedescendant dance.
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, LayoutGrid } from "lucide-react";
import { cn } from "@/shared/lib";

export interface SectionPickerOption {
  id: string;
  title: string;
  subtitle?: string;
}

export interface SectionPickerGroup {
  key: string;
  label: string;
  options: SectionPickerOption[];
}

export interface SectionPickerProps {
  groups: SectionPickerGroup[];
  /** Currently open section id. */
  value: string;
  onChange: (id: string) => void;
  /** Accessible name for the trigger and the listbox. */
  ariaLabel: string;
  /** Small label rendered above the trigger (e.g. "التقرير"). */
  label: string;
  className?: string;
}

export function SectionPicker({
  groups,
  value,
  onChange,
  ariaLabel,
  label,
  className,
}: SectionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const flat = groups.flatMap((g) => g.options);
  const selectedIndex = Math.max(
    0,
    flat.findIndex((o) => o.id === value)
  );
  const current = flat[selectedIndex];
  const [active, setActive] = useState(selectedIndex);

  // Opening always starts on the current report — not on the first one — so the
  // menu reads as "you are here, and here is what else there is".
  useEffect(() => {
    if (open) setActive(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  const pick = (id: string) => {
    close();
    if (id !== value) onChange(id);
  };

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const last = flat.length - 1;
      setActive((i) => {
        if (e.key === "Home") return 0;
        if (e.key === "End") return last;
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        return next < 0 ? last : next > last ? 0 : next;
      });
    }
  }

  let optionIndex = -1;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <span className="mb-1 block text-[11px] font-bold text-slate-500">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-11 w-full min-w-[15rem] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-start shadow-soft transition-colors hover:border-teal-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 sm:w-auto"
      >
        <LayoutGrid className="h-4 w-4 shrink-0 text-teal-700" aria-hidden="true" />
        <span className="flex-1 truncate text-sm font-extrabold text-slate-900">
          {current?.title}
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className="absolute z-30 mt-1 max-h-[70vh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lift start-0"
        >
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label} className="py-1">
              <div className="px-2.5 pb-1 pt-1 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
                {group.label}
              </div>
              {group.options.map((opt) => {
                optionIndex += 1;
                const i = optionIndex;
                const isSelected = opt.id === value;
                return (
                  <button
                    key={opt.id}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => pick(opt.id)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-start transition-colors focus:outline-none",
                      isSelected ? "bg-teal-50" : "hover:bg-slate-50 focus-visible:bg-slate-50"
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        isSelected ? "text-teal-700" : "text-transparent"
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-sm font-bold",
                          isSelected ? "text-teal-900" : "text-slate-900"
                        )}
                      >
                        {opt.title}
                      </span>
                      {opt.subtitle && (
                        <span className="mt-0.5 block text-xs font-medium leading-snug text-slate-500">
                          {opt.subtitle}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
