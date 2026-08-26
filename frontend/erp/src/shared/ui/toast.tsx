import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/shared/lib";
import { useOptionalLang } from "@/i18n";
import { useTx } from "./i18n";

export type ToastTone = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss after N ms (default 4500; 0 keeps it until dismissed). */
  duration?: number;
}

interface ToastRecord extends Required<Omit<ToastOptions, "description">> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  toast: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { ring: string; icon: ReactNode }> = {
  success: { ring: "border-emerald-200", icon: <CheckCircle2 className="h-5 w-5 text-emerald-600" /> },
  error: { ring: "border-rose-200", icon: <XCircle className="h-5 w-5 text-rose-600" /> },
  info: { ring: "border-sky-200", icon: <Info className="h-5 w-5 text-sky-600" /> },
  warning: { ring: "border-amber-200", icon: <AlertTriangle className="h-5 w-5 text-amber-600" /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTx();
  const lang = useOptionalLang() ?? "ar";
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = ++seq.current;
      const record: ToastRecord = {
        id,
        title: opts.title,
        description: opts.description,
        tone: opts.tone ?? "info",
        duration: opts.duration ?? 4500,
      };
      setToasts((list) => [...list, record]);
      if (record.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), record.duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-x-0 top-4 z-modal flex flex-col items-center gap-2 px-4"
            role="region"
            aria-label={t("sharedUi.toast.region")}
          >
            <AnimatePresence initial={false}>
              {toasts.map((toastRecord) => {
                const style = TONE_STYLES[toastRecord.tone];
                return (
                  <motion.div
                    key={toastRecord.id}
                    layout
                    initial={{ opacity: 0, y: -12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ type: "spring", damping: 26, stiffness: 320 }}
                    role="status"
                    aria-live={toastRecord.tone === "error" ? "assertive" : "polite"}
                    dir={lang === "ar" ? "rtl" : "ltr"}
                    className={cn(
                      "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-white p-4 shadow-lift",
                      style.ring,
                    )}
                  >
                    <span className="mt-0.5 shrink-0" aria-hidden="true">
                      {style.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-extrabold text-slate-900">{toastRecord.title}</div>
                      {toastRecord.description && (
                        <div className="mt-0.5 text-xs font-medium text-slate-500">{toastRecord.description}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={t("sharedUi.toast.close")}
                      onClick={() => dismiss(toastRecord.id)}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/** Access the toast API. Must be called under a <ToastProvider>. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a <ToastProvider>");
  return ctx;
}
