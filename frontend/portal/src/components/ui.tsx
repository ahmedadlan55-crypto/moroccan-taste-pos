// The portal's primitives.
//
// Deliberately small: this app has six screens and one shape of content (a
// card with a heading and some figures). Every colour comes from the ADLAN
// tokens via Tailwind (frontend/shared/design-tokens.css) — no hex literals,
// which scripts/check-design-tokens.mjs enforces for new files.
//
// Direction: logical properties ONLY (ps-/pe-, ms-/me-, start-/end-,
// text-start/text-end). scripts/check-rtl-literals.mjs fails a new file that
// uses a physical one, and it is right to: this UI runs RTL by default and
// LTR on a toggle, in the same session.
import React from "react";
import { AlertTriangle, Inbox, Loader2, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";

// ─── Button ──────────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Fills the row — the default for a phone. */
  block?: boolean;
  loading?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-teal-600 text-white shadow-sm hover:bg-teal-700 active:bg-teal-700",
  secondary: "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
  ghost: "text-slate-600 hover:bg-slate-100",
  danger: "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
};

export function Button({
  variant = "primary",
  block = false,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // min-h-12: a thumb target, not a mouse target (WCAG 2.5.5 asks 44px).
      className={cn(
        "btn-press inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold",
        "disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_VARIANTS[variant],
        block && "w-full",
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function Card({
  title,
  action,
  className,
  bodyClassName,
  children,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("surface overflow-hidden", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-sm font-extrabold text-slate-900">{title}</h2>}
          {action}
        </header>
      )}
      <div className={cn("px-4 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}

// ─── Stat ────────────────────────────────────────────────────────────────────

/**
 * One figure with its label. `tone` carries meaning, not decoration: a figure
 * that reduces pay is rose, one that adds is emerald, everything else is neutral.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "neutral" | "good" | "bad" | "accent";
  className?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "bad"
        ? "text-rose-600"
        : tone === "accent"
          ? "text-teal-700"
          : "text-slate-900";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[11px] font-bold text-slate-500">{label}</div>
      <div className={cn("mt-0.5 flex items-baseline gap-1", toneClass)}>
        <span className="num text-xl font-extrabold">{value}</span>
        {unit && <span className="text-[11px] font-bold text-slate-400">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 truncate text-[10px] font-semibold text-slate-400">{hint}</div>}
    </div>
  );
}

/** A responsive row of stats — 2 across on a phone, 4 on a wide screen. */
export function StatGrid({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 }) {
  return (
    <div className={cn("grid gap-4", cols === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4")}>
      {children}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "good" | "warn" | "bad" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  bad: "border-rose-200 bg-rose-50 text-rose-700",
  info: "border-teal-200 bg-teal-50 text-teal-700",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return <span className={cn("chip", BADGE_TONES[tone])}>{children}</span>;
}

/** Maps the server's status vocabulary onto a tone. Unknown → neutral. */
export function statusTone(status: string | null | undefined): BadgeTone {
  const s = String(status ?? "").toLowerCase();
  if (["approved", "present", "active", "posted", "paid"].includes(s)) return "good";
  if (["pending", "close_pending", "partial", "draft"].includes(s)) return "warn";
  if (["rejected", "absent", "cancelled", "canceled"].includes(s)) return "bad";
  if (["late", "early_leave", "leave", "holiday", "weekend"].includes(s)) return "info";
  return "neutral";
}

// ─── States ──────────────────────────────────────────────────────────────────

export function LoadingState({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={cn("flex items-center justify-center gap-2 py-10 text-sm font-bold text-slate-400", className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {t("common.loading")}
    </div>
  );
}

export function EmptyState({ message, icon }: { message?: React.ReactNode; icon?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="text-slate-300" aria-hidden>
        {icon ?? <Inbox className="h-7 w-7" />}
      </div>
      <p className="text-sm font-bold text-slate-400">{message ?? t("common.empty")}</p>
    </div>
  );
}

/**
 * The failure state. It distinguishes "your phone has no signal" from "the
 * server said no", because the two need different actions from the employee
 * and an app that blurs them teaches people to ignore it.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const offline = error instanceof ApiError && error.isOffline;
  const message =
    error instanceof Error && error.message ? error.message : t("common.offline");

  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className={offline ? "text-slate-300" : "text-amber-400"} aria-hidden>
        {offline ? <WifiOff className="h-7 w-7" /> : <AlertTriangle className="h-7 w-7" />}
      </div>
      <div>
        <p className="text-sm font-extrabold text-slate-700">
          {offline ? t("common.offline") : message}
        </p>
        {offline && <p className="mt-1 text-xs font-semibold text-slate-400">{t("common.offlineHint")}</p>}
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="min-h-10 px-3 text-xs">
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

// ─── Field row ───────────────────────────────────────────────────────────────

/** A label/value pair — the profile screen is a column of these. */
export function FieldRow({
  label,
  value,
  numeric = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs font-bold text-slate-500">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-end text-sm font-extrabold text-slate-800",
          numeric && "num",
        )}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

// ─── Sheet (bottom modal) ────────────────────────────────────────────────────

/**
 * A bottom sheet, not a centred dialog: on a phone the bottom is where the
 * thumb is, and a centred dialog fights the on-screen keyboard.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const t = useT();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Freeze the page behind the sheet so a scroll gesture doesn't move it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className="absolute inset-0 bg-slate-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className="animate-sheet-in safe-bottom relative flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-extrabold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100"
          >
            {t("common.close")}
          </button>
        </header>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="border-t border-slate-100 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
