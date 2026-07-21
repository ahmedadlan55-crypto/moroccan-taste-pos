import { Component, type ErrorInfo, type ReactNode } from "react";

// Top-level safety net: any render/runtime error thrown anywhere in the tree is
// caught here and replaced with a friendly bilingual recovery screen instead of
// a blank white page. React error boundaries must be class components.
//
// NOTE: this component is intentionally NOT wired to useT()/I18nProvider — it
// must render correctly even if the provider itself throws during init (it is
// the crash fallback screen). Strings for both languages are hardcoded below,
// and the active language is read directly from localStorage (erp_lang, the same
// key the I18nProvider persists) via a local, dependency-free try/catch instead
// of any hook or context. Mirrors the POS ErrorBoundary
// (frontend/pos/src/components/ErrorBoundary.tsx), keyed on erp_lang not pos_lang.
interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

const STRINGS = {
  ar: {
    title: "حدث خطأ غير متوقّع",
    body: "نأسف على الإزعاج، حدث خلل مؤقّت في الواجهة. جرّب إعادة تحميل الصفحة، وإن استمرّت المشكلة تواصل مع الدعم الفني.",
    reload: "إعادة تحميل الصفحة",
  },
  en: {
    title: "Something went wrong",
    body: "We're sorry for the inconvenience, a temporary glitch occurred in the interface. Try reloading the page, and if the problem persists contact technical support.",
    reload: "Reload Page",
  },
} as const;

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a diagnostic trail in the console; never surface raw errors to users.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    // Local, dependency-free language read: must survive even if I18nProvider
    // itself is what crashed, so this deliberately does not use useLang(). The
    // default ("ar") matches the I18nProvider's own default.
    const lang = (() => {
      try {
        return localStorage.getItem("erp_lang") === "en" ? "en" : "ar";
      } catch {
        return "ar";
      }
    })();
    const dir = lang === "en" ? "ltr" : "rtl";
    const t = STRINGS[lang];

    return (
      <div dir={dir} className="grid min-h-screen place-items-center bg-canvas p-6 font-sans">
        <div className="grid max-w-md place-items-center gap-3 rounded-2xl bg-white p-10 text-center shadow-soft">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-600" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1 className="text-lg font-extrabold text-ink">{t.title}</h1>
          <p className="text-sm font-medium text-slate-500">{t.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-1 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-600 px-6 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-teal-700"
          >
            {t.reload}
          </button>
        </div>
      </div>
    );
  }
}
